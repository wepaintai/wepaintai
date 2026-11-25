// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const PREVIEW_DIR = fileURLToPath(new URL('.', import.meta.url))
const POOL_COMMON = join(PREVIEW_DIR, 'pool-common.sh')
const DEPLOY = join(PREVIEW_DIR, 'deploy-preview.sh')
const REMOVE = join(PREVIEW_DIR, 'remove-preview.sh')
const BIN_FILES = ['pool-common.sh', 'slot-compose.yml', 'remove-preview.sh']

let root: string
let lockDir: string

function bash(script: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PREVIEW_ROOT: root,
      PREVIEW_CONFIG: join(root, 'no-config.env'),
      ...env,
    },
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function holdLock(pid: string | null) {
  mkdirSync(lockDir, { recursive: true })
  if (pid !== null) writeFileSync(join(lockDir, 'pid'), pid)
}

function deadPid() {
  return String(spawnSync('true').pid)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preview-pool-'))
  lockDir = join(root, 'locks', 'pool.lock')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('preview_release_lock', () => {
  test('never removes a lock owned by another live process', () => {
    holdLock(String(process.pid))
    const r = bash(`source "${POOL_COMMON}"; preview_release_lock`)
    expect(r.status).toBe(0)
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid))
  })

  test('never removes a lock whose pid file is not written yet', () => {
    holdLock(null)
    expect(bash(`source "${POOL_COMMON}"; preview_release_lock`).status).toBe(0)
    expect(existsSync(lockDir)).toBe(true)

    writeFileSync(join(lockDir, 'pid'), '')
    expect(bash(`source "${POOL_COMMON}"; preview_release_lock`).status).toBe(0)
    expect(existsSync(lockDir)).toBe(true)
  })

  test("removes the caller's own lock", () => {
    const r = bash(
      `source "${POOL_COMMON}"; preview_acquire_lock; test "$(cat "${lockDir}/pid")" = "$$"; preview_release_lock`
    )
    expect(r.status).toBe(0)
    expect(existsSync(lockDir)).toBe(false)
  })

  // Regression: a waiter that timed out used to delete another process's lock
  // in the window between that process's `mkdir` and its pid write.
  test.each([
    ['held by a live process', String(process.pid)],
    ['freshly created, pid not yet written', null],
  ])('a waiter that times out leaves a lock %s intact', (_label, pid) => {
    holdLock(pid)
    // Even with the old (unsafe) trap-before-acquire ordering, release must
    // refuse to delete a lock it does not own.
    const r = bash(
      `source "${POOL_COMMON}"; trap 'preview_release_lock' EXIT; preview_acquire_lock`,
      { PREVIEW_LOCK_TIMEOUT_SECONDS: '1' }
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Timed out waiting for preview pool lock')
    expect(existsSync(lockDir)).toBe(true)
    if (pid !== null) expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(pid)
  })
})

describe('preview_acquire_lock', () => {
  test('recovers a lock left by a dead process', () => {
    holdLock(deadPid())
    const r = bash(
      `source "${POOL_COMMON}"; preview_acquire_lock; cat "${lockDir}/pid"; echo "self=$$"`,
      {
        PREVIEW_LOCK_TIMEOUT_SECONDS: '3',
      }
    )
    expect(r.status).toBe(0)
    const [owner, self] = r.stdout.trim().split('\n')
    expect(self).toBe(`self=${owner}`)
  })

  test('recovers an empty lock older than 5 seconds on both BSD and GNU stat', () => {
    holdLock(null)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDir, old, old)
    const r = bash(`source "${POOL_COMMON}"; preview_acquire_lock`, {
      PREVIEW_LOCK_TIMEOUT_SECONDS: '3',
    })
    expect(r.status).toBe(0)
    expect(readFileSync(join(lockDir, 'pid'), 'utf8').trim()).toMatch(/^\d+$/)
  })
})

describe('trap ordering', () => {
  test.each([
    ['deploy-preview.sh', DEPLOY],
    ['remove-preview.sh', REMOVE],
  ])('%s installs the release trap only after acquiring the lock', (_name, file) => {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
    const acquire = code.findIndex((line) => line.trim() === 'preview_acquire_lock')
    const trap = code.findIndex((line) => line.includes("trap 'preview_release_lock' EXIT"))
    expect(acquire).toBeGreaterThanOrEqual(0)
    expect(trap).toBe(acquire + 1)
  })
})

describe('preview_sync_host_bin', () => {
  let bin: string

  beforeEach(() => {
    bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
  })

  const sync = () => bash(`source "${POOL_COMMON}"; preview_sync_host_bin "${PREVIEW_DIR}"`)

  test('reinstalls tampered and missing helpers from the trusted checkout', () => {
    copyFileSync(POOL_COMMON, join(bin, 'pool-common.sh'))
    writeFileSync(join(bin, 'remove-preview.sh'), '#!/bin/sh\necho pwned\n')
    chmodSync(join(bin, 'remove-preview.sh'), 0o755)

    const r = sync()
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('Preview host helper mismatch')
    expect(r.stderr).toContain(`${bin}/remove-preview.sh sha256=`)
    expect(r.stderr).toContain(`${bin}/slot-compose.yml sha256=missing`)
    expect(r.stderr).toContain('PREVIEW_BIN_REINSTALLED files=slot-compose.yml remove-preview.sh')
    for (const name of BIN_FILES) {
      expect(readFileSync(join(bin, name), 'utf8')).toBe(
        readFileSync(join(PREVIEW_DIR, name), 'utf8')
      )
    }
    expect(statSync(join(bin, 'remove-preview.sh')).mode & 0o111).not.toBe(0)
  })

  test('replaces a planted symlink without touching its target', () => {
    for (const name of BIN_FILES) copyFileSync(join(PREVIEW_DIR, name), join(bin, name))
    const evil = join(root, 'evil.sh')
    writeFileSync(evil, '#!/bin/sh\necho pwned\n')
    rmSync(join(bin, 'remove-preview.sh'))
    symlinkSync(evil, join(bin, 'remove-preview.sh'))

    const r = sync()
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('PREVIEW_BIN_REINSTALLED files=remove-preview.sh')
    expect(lstatSync(join(bin, 'remove-preview.sh')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(bin, 'remove-preview.sh'), 'utf8')).toBe(readFileSync(REMOVE, 'utf8'))
    expect(readFileSync(evil, 'utf8')).toBe('#!/bin/sh\necho pwned\n')
  })

  test('is silent when every helper matches', () => {
    for (const name of BIN_FILES) copyFileSync(join(PREVIEW_DIR, name), join(bin, name))
    const r = sync()
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('refuses to treat $PREVIEW_ROOT/bin as the trusted source', () => {
    const r = bash(`source "${POOL_COMMON}"; preview_sync_host_bin "${bin}"`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('trusted dir must not be')
  })
})

describe('deploy-preview.sh trust boundary', () => {
  test('never sources or executes helpers from $PREVIEW_ROOT/bin', () => {
    const code = readFileSync(DEPLOY, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/source\s+"\$(ROOT|ROOT_DEFAULT|PREVIEW_ROOT)/)
    expect(code).not.toMatch(
      /\$(ROOT|PREVIEW_ROOT)\/bin\/(pool-common|remove-preview|slot-compose)/
    )
    expect(code).toContain('source "$SCRIPT_DIR/pool-common.sh"')
    expect(code).toContain('REMOVE_SCRIPT="$SCRIPT_DIR/remove-preview.sh"')
    expect(code).toContain('preview_sync_host_bin "$SCRIPT_DIR"')
    expect(code).toContain('corepack pnpm install --frozen-lockfile --ignore-scripts')
  })

  test('requires a PR source directory', () => {
    const r = bash(`"${DEPLOY}" 123`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('usage: deploy-preview.sh <pr-number> <pr-source-dir>')
  })

  test('refuses to build the trusted checkout itself', () => {
    const repoRoot = join(PREVIEW_DIR, '..', '..')
    const r = bash(`"${DEPLOY}" 123 "${repoRoot}"`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Refusing to build PR source')
  })

  test('refuses a PR checkout that is not at the verified head SHA', () => {
    const src = mkdtempSync(join(tmpdir(), 'preview-src-'))
    try {
      const gitEnv = {
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      }
      expect(
        bash(`cd "${src}" && git init -q && git commit -q --allow-empty -m init`, gitEnv).status
      ).toBe(0)
      const r = bash(`"${DEPLOY}" 123 "${src}" ${'a'.repeat(40)}`)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/PR checkout is at [0-9a-f]{40}, expected a{40}/)

      const bad = bash(`"${DEPLOY}" 123 "${src}" 'HEAD; rm -rf /'`)
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain('Expected head SHA must be lowercase hex')
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })
})
