import { promises as fsp } from 'node:fs'
import path, { basename, join } from 'node:path'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { utils, type SFTPWrapper, type Stats } from 'ssh2'
import type { ConnectTarget, FileEntry, SaveResult, SessionEvent, TextFile, TransferDirection, TransferInfo } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Prompter, Send } from '../prompts'
import type { Vault } from '../vault'
import { CancelledError, closeConnection, connect, type Connection } from './connect'
import { RemoteEditor } from './remote-edit'
import { RemoteDatabases } from '../sqlite'
import { call, isInside, localName, readBounded } from './sftp-util'

const CHUNK = 32 * 1024
const TEXT_MAX = 5 * 1024 * 1024
const MAX_DEPTH = 64
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0')
const PARALLEL = 32
const BULK_REQUESTS = 128
const FILES_AT_ONCE = 8
const SHOW_DELETE_AFTER = 300
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

type Policy = 'replace' | 'rename' | 'skip'

interface Batch {
  policy?: Policy
  conflicts?: Promise<void>
  reserved?: Set<string>
}

interface Job {
  info: TransferInfo
  cancelled: boolean
  workers?: number
  requestBudget?: number
  hidden?: boolean
  batch: Batch
  run: (job: Job) => Promise<void>
}

class SkippedError extends Error {}

type Exists = (target: string) => Promise<'file' | 'dir' | null>

interface Session {
  id: string
  abort: AbortController
  conn?: Connection
  sftp?: SFTPWrapper
  bulk?: Promise<SFTPWrapper>
  active: Set<Job>
  queue: Job[]
  running: boolean
  closed: boolean
  userClosed?: boolean
  borrowed?: boolean
  release?: () => void
}

interface Planned {
  dirs: string[]
  files: { src: string; dest: string; size: number }[]
}

const isDir = (mode: number): boolean => (mode & S_IFMT) === S_IFDIR
const isLink = (mode: number): boolean => (mode & S_IFMT) === S_IFLNK

async function parallel(count: number, job: Job, take: () => (() => Promise<void>) | undefined): Promise<void> {
  let failed = false
  const worker = async (): Promise<void> => {
    try {
      for (let task = take(); task && !failed; task = take()) {
        if (job.cancelled) throw new CancelledError()
        await task()
      }
    } catch (err) {
      failed = true
      throw err
    }
  }
  const results = await Promise.allSettled(Array.from({ length: count }, worker))
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected) throw rejected.reason
}

function pump(size: number, work: (pos: number, len: number) => Promise<void>, job: Job, requests: number): Promise<void> {
  let next = 0
  return parallel(Math.min(requests, Math.ceil(size / CHUNK)), job, () => {
    if (next >= size) return undefined
    const pos = next
    const len = Math.min(CHUNK, size - pos)
    next += len
    return () => work(pos, len)
  })
}

function each<T>(items: T[], work: (item: T) => Promise<void>, job: Job, count = FILES_AT_ONCE): Promise<void> {
  let next = 0
  return parallel(Math.min(count, items.length), job, () => {
    if (next >= items.length) return undefined
    const item = items[next++]
    return () => work(item)
  })
}

export class SftpSessions {
  private sessions = new Map<string, Session>()
  readonly editor: RemoteEditor
  readonly databases: RemoteDatabases
  private jobs = new Map<string, Job>()
  private lastEmit = new Map<string, number>()

  constructor(
    private vault: Vault,
    private prompter: Prompter,
    private send: Send
  ) {
    this.editor = new RemoteEditor((id) => this.get(id), prompter, send, vault)
    this.databases = new RemoteDatabases((id) => this.get(id))
  }

  private status(sessionId: string, status: SessionEvent['status'], message?: string, dropped?: boolean): void {
    const event: SessionEvent = { sessionId, status, message, dropped }
    this.send('sftp:status', event)
  }

  private get(sessionId: string): SFTPWrapper {
    const sftp = this.sessions.get(sessionId)?.sftp
    if (!sftp) throw new Error('SFTP session is not connected')
    return sftp
  }

  private bulkChannel(sessionId: string): Promise<SFTPWrapper> {
    const browsing = this.get(sessionId)
    const session = this.sessions.get(sessionId)!
    // Keep queued bulk packets off the browsing channel and reuse the existing SSH login.
    return session.bulk ??= call<SFTPWrapper>((cb) => session.conn!.client.sftp(cb)).then((channel) => {
      if (session.closed) {
        channel.end()
        throw new CancelledError()
      }
      channel.once('close', () => { session.bulk = undefined })
      return channel
    }, () => {
      // Some servers allow only one subsystem channel per connection.
      session.bulk = undefined
      if (session.closed) throw new CancelledError()
      return browsing
    })
  }

  open(sessionId: string, target: ConnectTarget): Promise<{ home: string; title: string }> {
    return this.start(sessionId, false, (session) =>
      connect(target, {
        vault: this.vault,
        ask: this.prompter.forSession(sessionId),
        signal: session.abort.signal,
        onProgress: (message) => this.status(sessionId, 'connecting', message)
      })
    )
  }

  // a channel on a terminal's connection: no second login, and closing it leaves the terminal connected
  attach(sessionId: string, conn: Connection | undefined): Promise<{ home: string; title: string }> {
    return this.start(sessionId, true, async () => {
      if (!conn) throw new Error('The terminal is not connected')
      return conn
    })
  }

  private async start(
    sessionId: string,
    borrowed: boolean,
    connectTo: (session: Session) => Promise<Connection>
  ): Promise<{ home: string; title: string }> {
    this.close(sessionId)
    const session: Session = { id: sessionId, abort: new AbortController(), queue: [], active: new Set(), running: false, closed: false, borrowed }
    this.sessions.set(sessionId, session)
    this.status(sessionId, 'connecting')
    try {
      session.conn = await connectTo(session)
      session.sftp = await call<SFTPWrapper>((cb) => session.conn!.client.sftp(cb))
      if (session.closed) throw new CancelledError()
    } catch (err) {
      session.sftp?.end()
      if (session.conn && !borrowed) closeConnection(session.conn)
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      const message = err instanceof CancelledError ? 'Cancelled' : (err as Error).message
      if (!session.closed) this.status(sessionId, err instanceof CancelledError ? 'closed' : 'error', message)
      throw new Error(message)
    }
    const { conn, sftp } = session
    const lost = (): void => this.finish(session, 'Connection lost')
    conn.client.on('close', lost)
    session.release = () => conn.client.off('close', lost)
    sftp.on('close', () => this.finish(session, 'SFTP channel closed'))
    const home = await call<string>((cb) => sftp.realpath('.', cb)).catch(() => '/')
    this.status(sessionId, 'connected')
    this.editor.resume(sessionId)
    return { home, title: conn.label }
  }

  private finish(session: Session, message: string): void {
    if (session.closed) return
    session.closed = true
    const dropped = !session.userClosed
    // edits survive a drop and upload again once the tab reconnects
    if (!dropped) this.editor.stopSession(session.id)
    this.sessions.delete(session.id)
    for (const job of session.queue) this.cancel(job.info.id)
    for (const job of session.active) this.cancel(job.info.id)
    void session.bulk?.then((channel) => {
      if (channel !== session.sftp) channel.end()
    }).catch(() => {})
    session.release?.()
    if (session.borrowed) session.sftp?.end()
    else if (session.conn) closeConnection(session.conn)
    this.status(session.id, 'closed', message, dropped)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.userClosed = true
    this.prompter.cancelSession(sessionId)
    session.abort.abort()
    this.finish(session, 'Closed')
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
    this.databases.closeAll()
  }

  async list(sessionId: string, dir: string): Promise<FileEntry[]> {
    const sftp = this.get(sessionId)
    const handle = await call<Buffer>((cb) => sftp.opendir(dir, cb))
    const items: { filename: string; attrs: Stats }[] = []
    try {
      for (;;) {
        const page = await call<typeof items>((cb) => sftp.readdir(handle, cb)).catch((err) => {
          if (err.code !== utils.sftp.STATUS_CODE.EOF) throw err
          return undefined
        })
        if (!page) break
        for (const item of page) items.push(item)
      }
    } finally {
      // The listing is ready at EOF. Send CLOSE without waiting another round trip to display it.
      void call((cb) => sftp.close(handle, cb)).catch(() => {})
    }
    return Promise.all(
      items
        .filter((i) => i.filename !== '.' && i.filename !== '..')
        .map(async ({ filename, attrs }) => {
          const path = posix.join(dir, filename)
          const link = isLink(attrs.mode)
          let linkDir = false
          if (link) {
            linkDir = await call<Stats>((cb) => sftp.stat(path, cb)).then(
              (s) => isDir(s.mode),
              () => false
            )
          }
          const entry: FileEntry = {
            name: filename,
            path,
            kind: link ? 'link' : isDir(attrs.mode) ? 'dir' : 'file',
            linkDir,
            size: attrs.size,
            mtime: attrs.mtime * 1000,
            mode: attrs.mode
          }
          return entry
        })
    )
  }

  async realpath(sessionId: string, path: string): Promise<string> {
    const sftp = this.get(sessionId)
    return call<string>((cb) => sftp.realpath(path, cb))
  }

  async readText(sessionId: string, path: string): Promise<TextFile> {
    const sftp = this.get(sessionId)
    const st = await call<Stats>((cb) => sftp.stat(path, cb))
    if (st.isDirectory()) throw new Error('Folders cannot be opened in an editor')
    if (!st.isFile()) throw new Error('Only regular files can be opened in an editor')
    const tooLarge = 'This file is larger than 5 MB. Download it or use an external editor.'
    if (st.size > TEXT_MAX) throw new Error(tooLarge)
    const data = await readBounded(sftp, path, TEXT_MAX, tooLarge)
    if (data.subarray(0, 16).equals(SQLITE_MAGIC)) throw new Error('This is a SQLite database, not text')
    if (data.subarray(0, 8000).includes(0)) throw new Error('This looks like a binary file')
    const bom = data.subarray(0, 3).equals(BOM)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? data.subarray(3) : data)
    } catch {
      throw new Error('This file is not UTF-8 text')
    }
    return { text, bom, mtime: st.mtime, size: st.size }
  }

  // expected is the stat from when the file was read; a mismatch means someone else changed it
  async writeText(
    sessionId: string,
    path: string,
    text: string,
    bom: boolean,
    expected: { mtime: number; size: number } | null
  ): Promise<SaveResult> {
    const sftp = this.get(sessionId)
    if (expected) {
      const st = await call<Stats>((cb) => sftp.stat(path, cb)).catch(() => null)
      if (st && (st.mtime !== expected.mtime || st.size !== expected.size)) return { conflict: true }
    }
    const body = Buffer.from(text, 'utf8')
    await call((cb) => sftp.writeFile(path, bom ? Buffer.concat([BOM, body]) : body, cb))
    const after = await call<Stats>((cb) => sftp.stat(path, cb))
    return { conflict: false, mtime: after.mtime, size: after.size }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = this.get(sessionId)
    await call((cb) => sftp.mkdir(path, cb))
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = this.get(sessionId)
    await call((cb) => sftp.rename(from, to, cb))
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const sftp = this.get(sessionId)
    await call((cb) => sftp.chmod(path, mode, cb))
  }

  async remove(sessionId: string, paths: string[]): Promise<boolean> {
    const sftp = this.get(sessionId)
    if (!paths.length) return true
    const name = paths.length === 1 ? posix.basename(paths[0]) : `${paths.length} items`
    const source = paths.length === 1 ? paths[0] : posix.dirname(paths[0])
    const job = this.createJob(sessionId, 'delete', name, source, '', {}, (j) => this.runDelete(sftp, paths, j))
    // a quick delete finishes before it would show, so it never clutters the activity list
    job.hidden = true
    const show = setTimeout(() => {
      job.hidden = false
      this.emit(job, true)
    }, SHOW_DELETE_AFTER)
    await this.execute(job)
    clearTimeout(show)
    if (job.info.state === 'error') throw new Error(job.info.error)
    return job.info.state === 'done'
  }

  private async runDelete(sftp: SFTPWrapper, paths: string[], job: Job): Promise<void> {
    const lstat = (p: string): Promise<Stats> => call<Stats>((cb) => sftp.lstat(p, cb))
    const files: string[] = []
    const levels: string[][] = []
    const add = (p: string, folder: boolean, dirs: string[]): void => {
      if (folder) dirs.push(p)
      else files.push(p)
      job.info.files++
      this.emit(job)
    }
    job.info.scanning = true
    this.emit(job, true)
    const top: string[] = []
    await each(paths, async (p) => add(p, isDir((await lstat(p)).mode), top), job)
    for (let level = top; level.length; ) {
      levels.push(level)
      const below: string[] = []
      await each(
        level,
        async (dir) => {
          const items = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(dir, cb))
          await Promise.all(
            items.map(async ({ filename, attrs }) => {
              if (filename === '.' || filename === '..') return
              const p = posix.join(dir, filename)
              // some servers describe a linked folder as a folder; lstat keeps the delete inside the tree
              add(p, isDir(attrs.mode) && isDir((await lstat(p)).mode), below)
            })
          )
        },
        job
      )
      level = below
    }
    this.scanned(job)
    const removed = (): void => {
      job.info.filesDone++
      this.emit(job)
    }
    await each(files, (p) => call((cb) => sftp.unlink(p, cb)).then(removed), job, PARALLEL)
    for (const dirs of levels.reverse()) {
      await each(dirs, (p) => call((cb) => sftp.rmdir(p, cb)).then(removed), job, PARALLEL)
    }
  }

  upload(sessionId: string, localPaths: string[], remoteDir: string): void {
    const batch: Batch = {}
    for (const src of localPaths) {
      const name = basename(src)
      this.enqueue(sessionId, 'upload', name, src, posix.join(remoteDir, name), batch, (job) => this.runUpload(sessionId, job))
    }
  }

  download(sessionId: string, remotePaths: string[], localDir: string): void {
    const batch: Batch = {}
    for (const src of remotePaths) {
      const name = localName(posix.basename(src))
      const dest = join(localDir, name)
      if (!isInside(localDir, dest)) throw new Error(`Refusing to download "${name}"`)
      this.enqueue(sessionId, 'download', name, src, dest, batch, (job) => this.runDownload(sessionId, job))
    }
  }

  private destinationKey(job: Job, dest: string): string {
    // Fold case conservatively for case-insensitive local and remote filesystems.
    return (job.info.direction === 'download' ? path.resolve(dest) : posix.normalize(dest)).normalize('NFC').toLowerCase()
  }

  private async resolveInOrder(sessionId: string, job: Job, exists: Exists, paths: typeof posix): Promise<string> {
    const previous = job.batch.conflicts
    const result = Promise.resolve(previous).then(() => {
      if (job.cancelled) throw new CancelledError()
      return this.resolveConflict(sessionId, job, exists, paths)
    })
    job.batch.conflicts = result.then(() => {}, () => {})
    return result
  }

  private async resolveConflict(sessionId: string, job: Job, exists: Exists, paths: typeof posix): Promise<string> {
    const kind = await exists(job.info.dest)
    if (!kind) return job.info.dest
    let choice = job.batch.policy
    if (!choice) {
      const answer = await this.prompter.forSession(sessionId)({
        kind: 'confirm',
        title: kind === 'dir' ? 'Folder already exists' : 'File already exists',
        message: `"${job.info.name}" already exists in ${paths.dirname(job.info.dest)}.`,
        fields: [],
        confirmLabel: '',
        checkbox: { name: 'all', label: 'Do the same for the rest of this transfer' },
        choices: [
          { id: 'replace', label: kind === 'dir' ? 'Merge' : 'Replace', danger: kind === 'file' },
          { id: 'rename', label: 'Keep both' },
          { id: 'skip', label: 'Skip' }
        ]
      })
      choice = (answer?.choice as Policy | undefined) ?? 'skip'
      if (answer?.checked) job.batch.policy = choice
    }
    if (choice === 'skip') throw new SkippedError()
    if (choice === 'replace') return job.info.dest
    const dir = paths.dirname(job.info.dest)
    const ext = kind === 'file' ? paths.extname(job.info.name) : ''
    const stem = job.info.name.slice(0, job.info.name.length - ext.length)
    for (let n = 1; n < 1000; n++) {
      const candidate = paths.join(dir, `${stem} (${n})${ext}`)
      const key = this.destinationKey(job, candidate)
      if (job.batch.reserved?.has(key) || await exists(candidate)) continue
      job.batch.reserved?.add(key)
      return candidate
    }
    throw new Error('No free name found')
  }

  cancel(transferId: string): void {
    const job = this.jobs.get(transferId)
    if (!job) return
    job.cancelled = true
    if (job.info.state === 'queued') {
      job.info.state = 'cancelled'
      this.emit(job, true)
    }
  }

  private enqueue(
    sessionId: string,
    direction: TransferDirection,
    name: string,
    source: string,
    dest: string,
    batch: Batch,
    run: Job['run']
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session?.sftp) throw new Error('SFTP session is not connected')
    const job = this.createJob(sessionId, direction, name, source, dest, batch, run)
    session.queue.push(job)
    this.emit(job, true)
    queueMicrotask(() => { void this.drain(session) })
  }

  private createJob(
    sessionId: string,
    direction: TransferDirection,
    name: string,
    source: string,
    dest: string,
    batch: Batch,
    run: Job['run']
  ): Job {
    const job: Job = {
      info: {
        id: randomUUID(),
        sessionId,
        direction,
        name,
        source,
        dest,
        bytes: 0,
        total: 0,
        files: 0,
        filesDone: 0,
        state: 'queued',
        startedAt: Date.now()
      },
      cancelled: false,
      batch,
      run
    }
    this.jobs.set(job.info.id, job)
    return job
  }

  private async drain(session: Session): Promise<void> {
    if (session.running) return
    session.running = true
    while (session.queue.length) {
      let limit = DEFAULT_SETTINGS.sftpParallelFiles
      try {
        const saved = this.vault.get().settings.sftpParallelFiles
        if (Number.isInteger(saved) && saved >= 1 && saved <= FILES_AT_ONCE) limit = saved
      } catch {
        // The vault can lock while the transfer queue is draining.
      }
      const first = session.queue.shift()!
      const group = [first]
      const reserved = new Set([this.destinationKey(first, first.info.dest)])
      // Only overlap jobs from one selection with distinct destinations.
      while (group.length < limit) {
        const next = session.queue[0]
        if (!next || next.batch !== first.batch) break
        const key = this.destinationKey(next, next.info.dest)
        if (reserved.has(key)) break
        reserved.add(key)
        group.push(session.queue.shift()!)
      }
      first.batch.reserved = reserved
      await Promise.all(group.map(async (job) => {
        if (job.cancelled) {
          this.jobs.delete(job.info.id)
          this.lastEmit.delete(job.info.id)
          return
        }
        job.workers = Math.floor(limit / group.length)
        job.requestBudget = Math.floor(BULK_REQUESTS / group.length)
        session.active.add(job)
        try {
          await this.execute(job)
        } finally {
          session.active.delete(job)
        }
      }))
    }
    session.running = false
  }

  private async execute(job: Job): Promise<void> {
    job.info.state = 'active'
    job.info.startedAt = Date.now()
    this.emit(job, true)
    try {
      await job.run(job)
      job.info.state = 'done'
    } catch (err) {
      job.info.state = err instanceof SkippedError ? 'skipped' : err instanceof CancelledError || job.cancelled ? 'cancelled' : 'error'
      if (job.info.state === 'error') job.info.error = (err as Error).message
    }
    this.emit(job, true)
    this.jobs.delete(job.info.id)
    this.lastEmit.delete(job.info.id)
  }

  private emit(job: Job, force = false): void {
    if (job.hidden) return
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(job.info.id) ?? 0) < 120) return
    this.lastEmit.set(job.info.id, now)
    this.send('sftp:transfer', { ...job.info })
  }

  private scanned(job: Job): void {
    job.info.scanning = false
    job.info.startedAt = Date.now()
    this.emit(job, true)
  }

  private progress(job: Job, bytes: number): void {
    job.info.bytes += bytes
    this.emit(job)
  }

  private async planLocal(src: string, dest: string, job: Job): Promise<Planned> {
    const plan: Planned = { dirs: [], files: [] }
    let level = [{ src, dest }]
    // Bound local metadata I/O and keep parents ahead of children for remote creation.
    while (level.length) {
      const below: typeof level = []
      await each(level, async ({ src, dest }) => {
        const st = await fsp.stat(src)
        if (!st.isDirectory()) {
          plan.files.push({ src, dest, size: st.size })
          return
        }
        plan.dirs.push(dest)
        for (const name of await fsp.readdir(src)) {
          below.push({ src: join(src, name), dest: posix.join(dest, name) })
        }
      }, job)
      level = below
    }
    return plan
  }

  // every local path is checked to stay inside dest; linked folders below the top level are skipped to avoid loops
  private async planRemote(sftp: SFTPWrapper, src: string, dest: string, job: Job): Promise<Planned> {
    const plan: Planned = { dirs: [], files: [] }
    const addFile = (s: string, d: string, size: number): void => {
      plan.files.push({ src: s, dest: d, size })
      job.info.files++
      job.info.total += size
      this.emit(job)
    }
    const top = await call<Stats>((cb) => sftp.stat(src, cb))
    if (!isDir(top.mode)) {
      if ((top.mode & S_IFMT) === S_IFREG) addFile(src, dest, top.size)
      return plan
    }
    let level = [{ s: src, d: dest }]
    for (let depth = 0; level.length; depth++) {
      if (depth >= MAX_DEPTH) throw new Error(`Folders nested deeper than ${MAX_DEPTH} levels are not downloaded`)
      const below: typeof level = []
      await each(
        level,
        async ({ s, d }) => {
          plan.dirs.push(d)
          const items = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(s, cb))
          await Promise.all(
            items.map(async ({ filename, attrs }) => {
              if (filename === '.' || filename === '..') return
              const from = posix.join(s, filename)
              const to = join(d, localName(filename))
              if (!isInside(dest, to)) throw new Error(`Refusing to write outside ${dest}`)
              let st: Stats | null = attrs
              if (isLink(st.mode)) {
                st = await call<Stats>((cb) => sftp.stat(from, cb)).catch(() => null)
                if (!st || isDir(st.mode)) return
              }
              if (isDir(st.mode)) below.push({ s: from, d: to })
              else if ((st.mode & S_IFMT) === S_IFREG) addFile(from, to, st.size)
            })
          )
        },
        job
      )
      level = below
    }
    return plan
  }

  private async runUpload(sessionId: string, job: Job): Promise<void> {
    const sftp = await this.bulkChannel(sessionId)
    if (job.cancelled) throw new CancelledError()
    job.info.dest = await this.resolveInOrder(
      sessionId,
      job,
      (p) => call<Stats>((cb) => sftp.stat(p, cb)).then((s) => (isDir(s.mode) ? 'dir' : 'file'), () => null),
      posix
    )
    job.info.scanning = true
    this.emit(job, true)
    const plan = await this.planLocal(job.info.source, job.info.dest, job)
    job.info.total = plan.files.reduce((n, f) => n + f.size, 0)
    job.info.files = plan.files.length
    this.scanned(job)

    // Create siblings concurrently after their parents exist. New directories need one round trip.
    const depths = new Map<string, number>()
    const levels: string[][] = []
    for (const dir of plan.dirs) {
      const depth = (depths.get(posix.dirname(dir)) ?? -1) + 1
      depths.set(dir, depth)
      const dirs = levels[depth] ??= []
      dirs.push(dir)
    }
    for (const dirs of levels) {
      await each(dirs, async (dir) => {
        try {
          await call((cb) => sftp.mkdir(dir, cb))
        } catch (err) {
          const existing = await call<Stats>((cb) => sftp.stat(dir, cb)).catch(() => undefined)
          if (!existing || !isDir(existing.mode)) throw err
        }
      }, job)
    }
    const requests = Math.floor((job.requestBudget ?? BULK_REQUESTS) / Math.max(1, Math.min(job.workers ?? FILES_AT_ONCE, plan.files.length)))
    await each(
      plan.files,
      async (file) => {
        await this.uploadFile(sftp, file.src, file.dest, job, requests)
        job.info.filesDone++
      },
      job,
      job.workers
    )
  }

  private async uploadFile(sftp: SFTPWrapper, src: string, dest: string, job: Job, requests: number): Promise<void> {
    const local = await fsp.open(src, 'r')
    const temp = posix.join(posix.dirname(dest), `.bawkterm-${randomUUID()}.part`)
    let staged = false
    let handle: Buffer | undefined
    try {
      const { size } = await local.stat()
      handle = await call<Buffer>((cb) => sftp.open(temp, 'wx', { mode: 0o600 }, cb))
      staged = true
      const remote = handle
      await pump(
        size,
        async (pos, len) => {
          const buf = Buffer.allocUnsafe(len)
          let got = 0
          while (got < len) {
            const { bytesRead } = await local.read(buf, got, len - got, pos + got)
            if (!bytesRead) throw new Error(`${src} changed while uploading`)
            got += bytesRead
          }
          await call((cb) => sftp.write(remote, buf, 0, len, pos, cb))
          this.progress(job, len)
        },
        job,
        requests
      )
      await call((cb) => sftp.close(remote, cb))
      handle = undefined
      if (job.cancelled) throw new CancelledError()
      // Publish only after the server acknowledges all writes and closes the staging file.
      await call((cb) => {
        try {
          sftp.ext_openssh_rename(temp, dest, cb)
        } catch (err) {
          if (!(err instanceof Error) || err.message !== 'Server does not support this extended request') throw err
          sftp.rename(temp, dest, cb)
        }
      })
      staged = false
    } finally {
      await local.close().catch(() => {})
      if (handle) await call((cb) => sftp.close(handle!, cb)).catch(() => {})
      if (staged) await call((cb) => sftp.unlink(temp, cb)).catch(() => {})
    }
  }

  private async runDownload(sessionId: string, job: Job): Promise<void> {
    const sftp = await this.bulkChannel(sessionId)
    if (job.cancelled) throw new CancelledError()
    job.info.dest = await this.resolveInOrder(
      sessionId,
      job,
      (p) => fsp.stat(p).then((s) => (s.isDirectory() ? 'dir' : 'file'), () => null),
      path as unknown as typeof posix
    )
    job.info.scanning = true
    this.emit(job, true)
    const plan = await this.planRemote(sftp, job.info.source, job.info.dest, job)
    this.scanned(job)

    for (const dir of plan.dirs) await fsp.mkdir(dir, { recursive: true })
    const requests = Math.floor((job.requestBudget ?? BULK_REQUESTS) / Math.max(1, Math.min(job.workers ?? FILES_AT_ONCE, plan.files.length)))
    await each(
      plan.files,
      async (file) => {
        await this.downloadFile(sftp, file.src, file.dest, job, requests)
        job.info.filesDone++
      },
      job,
      job.workers
    )
  }

  private async downloadFile(sftp: SFTPWrapper, src: string, dest: string, job: Job, requests: number): Promise<void> {
    const handle = await call<Buffer>((cb) => sftp.open(src, 'r', cb))
    const temp = join(path.dirname(dest), `.bawkterm-${randomUUID()}.part`)
    let staged = false
    let local: Awaited<ReturnType<typeof fsp.open>> | undefined
    try {
      const { size } = await call<Stats>((cb) => sftp.fstat(handle, cb))
      if (job.cancelled) throw new CancelledError()
      const output = local = await fsp.open(temp, 'wx', 0o600)
      staged = true
      await pump(
        size,
        async (pos, len) => {
          const buf = Buffer.allocUnsafe(len)
          let got = 0
          while (got < len) {
            const n = await call<number>((cb) => sftp.read(handle, buf, got, len - got, pos + got, cb))
            if (!n) throw new Error(`${src} changed while downloading`)
            got += n
          }
          for (let written = 0; written < len; ) {
            const { bytesWritten } = await output.write(buf, written, len - written, pos + written)
            if (!bytesWritten) throw new Error(`Unable to write ${dest}`)
            written += bytesWritten
          }
          this.progress(job, len)
        },
        job,
        requests
      )
      await output.close()
      local = undefined
      if (job.cancelled) throw new CancelledError()
      await fsp.rename(temp, dest)
      staged = false
    } finally {
      await local?.close().catch(() => {})
      await call((cb) => sftp.close(handle, cb)).catch(() => {})
      if (staged) await fsp.rm(temp, { force: true }).catch(() => {})
    }
  }
}
