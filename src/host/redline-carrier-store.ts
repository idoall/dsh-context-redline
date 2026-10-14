import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  carrierFileName,
  parseCarrierOperation,
  serializeCarrierOperation,
  type CarrierOperation,
  type ParseCarrierResult,
} from '../shared/redline-carrier'
import { REDLINE_DATA_DIR_NAME } from '../shared/redline-paths'

export type CarrierStoreErrorCode = 'missing' | 'corrupt' | 'schema' | 'identity' | 'io' | 'updater' | 'unavailable'

export class CarrierStoreError extends Error {
  constructor(readonly code: CarrierStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CarrierStoreError'
  }
}

export interface CarrierStoreFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
  syncFile?(path: string): Promise<void>
  syncDirectory?(path: string): Promise<void>
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

const nodeFileSystem: CarrierStoreFileSystem = {
  mkdir, readFile, readdir, writeFile, rename, rm,
  syncFile: syncPath,
  syncDirectory: syncPath,
}
/** Shared across every store instance in this process; route and restart recovery must serialize together. */
const mutationQueues = new Map<string, Promise<void>>()

type HomePath = (...segments: string[]) => string
export interface CarrierStoreContext {
  get(name: string): unknown
}
export interface CarrierStoreOptions {
  readonly fs?: CarrierStoreFileSystem
}
export interface RedlineCarrierStore {
  readonly fileSystem: CarrierStoreFileSystem
  read(opId: string): Promise<ParseCarrierResult>
  write(operation: CarrierOperation): Promise<void>
  listOperationIds(): Promise<string[]>
  mutate(opId: string, updater: (current: CarrierOperation) => CarrierOperation): Promise<CarrierOperation>
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function storeError(code: CarrierStoreErrorCode, message: string, cause?: unknown): CarrierStoreError {
  return new CarrierStoreError(code, message, cause === undefined ? undefined : { cause })
}

function strictParsed(result: ParseCarrierResult): CarrierOperation {
  if (result.ok) return result.operation
  throw storeError(result.code, result.message)
}

export function createRedlineCarrierStore(
  ctx: CarrierStoreContext,
  options: CarrierStoreOptions = {},
): RedlineCarrierStore {
  const fs = options.fs ?? nodeFileSystem
  const homePath = ctx.get('dshHomePath')
  if (typeof homePath !== 'function') throw storeError('unavailable', 'the harness home is not available')

  let dataDir: string
  try {
    dataDir = join((homePath as HomePath)(REDLINE_DATA_DIR_NAME))
  } catch (error) {
    throw storeError('unavailable', 'the harness home is not available', error)
  }

  const targetOf = (opId: string) => join(dataDir, carrierFileName(opId))

  async function readOperation(opId: string): Promise<ParseCarrierResult> {
    let raw: string
    try {
      raw = await fs.readFile(targetOf(opId), 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return parseCarrierOperation(null, opId)
      throw storeError('io', `failed to read carrier operation ${opId}`, error)
    }
    const parsed = parseCarrierOperation(raw, opId)
    if (!parsed.ok) throw storeError(parsed.code === 'missing' ? 'corrupt' : parsed.code, parsed.message)
    return parsed
  }

  async function writeOperation(operation: CarrierOperation): Promise<void> {
    const serialized = serializeCarrierOperation(operation)
    const checked = parseCarrierOperation(serialized, operation.opId)
    if (!checked.ok) {
      throw storeError(checked.code === 'missing' ? 'corrupt' : checked.code, checked.message)
    }

    const target = targetOf(operation.opId)
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
    try {
      await fs.mkdir(dataDir, { recursive: true })
      await fs.writeFile(temp, serialized, 'utf8')
      await fs.syncFile?.(temp)
      await fs.rename(temp, target)
      await fs.syncDirectory?.(dataDir)
    } catch (error) {
      try {
        await fs.rm(temp, { force: true })
      } catch {
        // Preserve the original write/rename error. The best-effort cleanup must
        // never mask why the durable replacement did not commit.
      }
      throw storeError('io', `failed to write carrier operation ${operation.opId}`, error)
    }
  }

  async function listOperationIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(dataDir)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw storeError('io', 'failed to list carrier operations', error)
    }

    const ids: string[] = []
    for (const name of names) {
      if (!name.startsWith('redline-carrier-') || !name.endsWith('.json')) continue
      let raw: string
      try {
        raw = await fs.readFile(join(dataDir, name), 'utf8')
      } catch (error) {
        throw storeError('io', `failed to read carrier ledger ${name}`, error)
      }
      const operation = strictParsed(parseCarrierOperation(raw))
      if (carrierFileName(operation.opId) !== name) {
        throw storeError('identity', `carrier filename identity mismatch: ${name}`)
      }
      ids.push(operation.opId)
    }
    return ids.sort((left, right) => left.localeCompare(right))
  }

  async function mutate(
    opId: string,
    updater: (current: CarrierOperation) => CarrierOperation,
  ): Promise<CarrierOperation> {
    const previous = mutationQueues.get(opId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    mutationQueues.set(opId, tail)
    await previous.catch(() => {})

    try {
      const currentResult = await readOperation(opId)
      if (!currentResult.ok) throw storeError(currentResult.code, currentResult.message)
      const current = currentResult.operation
      const updated = updater(current)
      if (updated.opId !== opId) throw storeError('identity', 'carrier updater changed the operation identity')
      if (updated.revision !== current.revision + 1) {
        throw storeError('updater', 'carrier updater must advance revision exactly once')
      }
      await writeOperation(updated)
      return updated
    } finally {
      release()
      if (mutationQueues.get(opId) === tail) mutationQueues.delete(opId)
    }
  }

  return { fileSystem: fs, read: readOperation, write: writeOperation, listOperationIds, mutate }
}
