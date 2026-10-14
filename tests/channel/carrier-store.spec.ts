import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import {
  CarrierStoreError,
  createRedlineCarrierStore,
  type CarrierStoreFileSystem,
} from '../../src/host/redline-carrier-store'
import {
  carrierFileName,
  createCarrierPreview,
  type CarrierOperation,
} from '../../src/shared/redline-carrier'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

function operation(opId = 'op/one'): CarrierOperation {
  return createCarrierPreview({
    opId,
    carrierId: `carrier-${opId}`,
    mainSessionId: 'main-session',
    plannedTitle: '↳ main · task',
    surfaceAsOfSeq: 12,
    surfaceFingerprint: 'surface-fingerprint',
    manifestFingerprint: 'manifest-fingerprint',
    promptRequestId: `prompt-${opId}`,
    returnRequestId: `return-${opId}`,
  })
}

async function harness(fs?: CarrierStoreFileSystem) {
  const home = await mkdtemp(join(tmpdir(), 'redline-carrier-store-'))
  homes.push(home)
  const ctx = { get(name: string) { return name === 'dshHomePath' ? (...segments: string[]) => join(home, ...segments) : undefined } }
  return { home, store: createRedlineCarrierStore(ctx, fs === undefined ? {} : { fs }) }
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<CarrierStoreError> {
  try {
    await promise
    assert.fail(`expected ${code}`)
  } catch (error) {
    assert.ok(error instanceof CarrierStoreError)
    assert.equal(error.code, code)
    return error
  }
}

describe('redline carrier store', () => {
  test('uses one namespaced file per operation and reports ENOENT as missing', async () => {
    const { home, store } = await harness()
    assert.deepEqual(await store.read('not-there'), { ok: false, code: 'missing', message: 'carrier operation is missing' })

    const op = operation()
    await store.write(op)
    const dir = join(home, 'dsh-context-redline')
    assert.deepEqual(await readdir(dir), [carrierFileName(op.opId)])
    assert.deepEqual(await store.read(op.opId), { ok: true, operation: op })
  })

  test.each([
    ['', 'corrupt'],
    ['   \n', 'corrupt'],
    ['{no', 'corrupt'],
    [JSON.stringify({ schemaVersion: 999 }), 'schema'],
  ])('refuses an existing invalid ledger (%s)', async (raw, code) => {
    const { home, store } = await harness()
    const dir = join(home, 'dsh-context-redline')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, carrierFileName('broken')), raw)
    await rejectsCode(store.read('broken'), code)
  })

  test('refuses a valid operation stored under another operation identity', async () => {
    const { home, store } = await harness()
    const dir = join(home, 'dsh-context-redline')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, carrierFileName('expected')), JSON.stringify(operation('other')))
    await rejectsCode(store.read('expected'), 'identity')
  })

  test('lists only carrier ledgers and validates each filename against its internal id', async () => {
    const { home, store } = await harness()
    await store.write(operation('zeta'))
    await store.write(operation('alpha'))
    const dir = join(home, 'dsh-context-redline')
    await writeFile(join(dir, 'notes.json'), '{}')
    await writeFile(join(dir, 'redline-carrier-ignore.txt'), '{}')
    assert.deepEqual(await store.listOperationIds(), ['alpha', 'zeta'])

    const alphaPath = join(dir, carrierFileName('alpha'))
    await writeFile(alphaPath, JSON.stringify(operation('impostor')))
    await rejectsCode(store.listOperationIds(), 'identity')
  })

  test('uses a unique temp file, removes it after rename failure, and preserves old valid bytes', async () => {
    const { home, store: initial } = await harness()
    const old = operation('atomic')
    await initial.write(old)
    const target = join(home, 'dsh-context-redline', carrierFileName(old.opId))
    const oldBytes = await readFile(target, 'utf8')
    const baseFs = initial.fileSystem
    let renamedFrom = ''
    const failingFs: CarrierStoreFileSystem = {
      ...baseFs,
      async rename(from, to) {
        renamedFrom = from
        assert.equal(to, target)
        throw Object.assign(new Error('rename failed'), { code: 'EIO' })
      },
    }
    const ctx = { get: () => (...segments: string[]) => join(home, ...segments) }
    const store = createRedlineCarrierStore(ctx, { fs: failingFs })
    const next = { ...old, revision: 2 }
    await rejectsCode(store.write(next), 'io')
    assert.notEqual(renamedFrom, target)
    assert.match(renamedFrom, /\.tmp-/)
    assert.equal(await readFile(target, 'utf8'), oldBytes)
    await assert.rejects(readFile(renamedFrom, 'utf8'), (error: unknown) => (error as { code?: string }).code === 'ENOENT')
  })

  test('removes a unique temp after write failure without touching old bytes', async () => {
    const { home, store: initial } = await harness()
    const old = operation('write-failure')
    await initial.write(old)
    const target = join(home, 'dsh-context-redline', carrierFileName(old.opId))
    const oldBytes = await readFile(target, 'utf8')
    const baseFs = initial.fileSystem
    let temp = ''
    const failingFs: CarrierStoreFileSystem = {
      ...baseFs,
      async writeFile(path, data, encoding) {
        temp = path
        assert.notEqual(path, target)
        await baseFs.writeFile(path, data, encoding)
        throw Object.assign(new Error('write failed'), { code: 'ENOSPC' })
      },
    }
    const ctx = { get: () => (...segments: string[]) => join(home, ...segments) }
    const store = createRedlineCarrierStore(ctx, { fs: failingFs })
    await rejectsCode(store.write({ ...old, revision: 2 }), 'io')
    assert.equal(await readFile(target, 'utf8'), oldBytes)
    await assert.rejects(readFile(temp, 'utf8'), (error: unknown) => (error as { code?: string }).code === 'ENOENT')
  })

  test('serializes same-operation mutations, strictly re-reads, applies the pure updater, and writes its next revision', async () => {
    const { store } = await harness()
    const original = operation('queued')
    await store.write(original)
    const seen: number[] = []
    const mutate = () => store.mutate(original.opId, current => {
      seen.push(current.revision)
      return { ...current, revision: current.revision + 1, plannedTitle: `${current.plannedTitle}!` }
    })
    const [first, second] = await Promise.all([mutate(), mutate()])
    assert.deepEqual(seen, [1, 2])
    assert.deepEqual([first.revision, second.revision], [2, 3])
    const final = await store.read(original.opId)
    assert.equal(final.ok, true)
    if (final.ok) {
      assert.equal(final.operation.revision, 3)
      assert.equal(final.operation.plannedTitle, '↳ main · task!!')
    }
  })

  test('rejects mutation of missing or corrupt state and invalid updater identity/revision', async () => {
    const { home, store } = await harness()
    await rejectsCode(store.mutate('missing', value => value), 'missing')
    const dir = join(home, 'dsh-context-redline')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, carrierFileName('bad')), ' ')
    await rejectsCode(store.mutate('bad', value => value), 'corrupt')

    const op = operation('guarded')
    await store.write(op)
    await rejectsCode(store.mutate(op.opId, current => ({ ...current, opId: 'changed', revision: 2 })), 'identity')
    await rejectsCode(store.mutate(op.opId, current => ({ ...current, revision: current.revision })), 'updater')
  })
})
