// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(REPO, path), 'utf8')
const WORKFLOWS = readdirSync(join(REPO, '.github/workflows')).filter((f) => f.endsWith('.yml'))

const BACKEND_DIGEST =
  'ghcr.io/convex/convex-backend@sha256:d4e012c68640830310139632481f8d1c1915bdf66de5c3a594a99799eab51679'
const DASHBOARD_DIGEST =
  'ghcr.io/convex/convex-dashboard@sha256:2cb0f7e51597ea41d08147649f9f65cb2676aa96ce1f2fce1531116a408e1c98'

describe('GitHub workflows', () => {
  test.each(WORKFLOWS)('%s pins every action to a commit SHA', (file) => {
    const uses = read(`.github/workflows/${file}`)
      .split('\n')
      .filter((line) => /^\s*(-\s+)?uses:/.test(line))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) {
      expect(line).toMatch(/uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
    }
  })

  test.each(WORKFLOWS)('%s never persists checkout credentials', (file) => {
    const text = read(`.github/workflows/${file}`)
    const checkouts = text.split('uses: actions/checkout@').length - 1
    const disabled = text.split('persist-credentials: false').length - 1
    expect(disabled).toBe(checkouts)
  })

  test('deploy-preview runs trusted main scripts and treats the PR as data', () => {
    const wf = read('.github/workflows/deploy-preview.yml')
    // The workflow file itself must come from the default branch.
    expect(wf).toMatch(/^ {2}pull_request_target:$/m)
    expect(wf).not.toMatch(/^ {2}pull_request:$/m)
    expect(wf).toMatch(/^ {4}environment: preview$/m)
    expect(wf).toMatch(
      /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n\s+path: trusted\n\s+persist-credentials: false/
    )
    expect(wf).toMatch(
      /ref: \$\{\{ steps\.verify\.outputs\.head_sha \}\}\n\s+path: pr\n\s+persist-credentials: false/
    )
    expect(wf).toContain('"$GITHUB_WORKSPACE/trusted/selfhost/preview/deploy-preview.sh"')
    expect(wf).toContain('"$PR" "$GITHUB_WORKSPACE/pr" "$HEAD_SHA"')
    expect(wf).not.toContain('./selfhost/preview/deploy-preview.sh')
    expect(wf).not.toContain('refs/pull/')
  })

  test('cleanup-preview never executes host-installed helpers', () => {
    const wf = read('.github/workflows/cleanup-preview.yml')
    const code = wf
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(wf).toMatch(/^ {2}pull_request_target:$/m)
    expect(code).not.toContain('wepaintai-previews/bin/')
    expect(wf).toContain('"$GITHUB_WORKSPACE/trusted/selfhost/preview/remove-preview.sh" "$PR"')
    expect(wf).not.toContain('head.sha')
  })

  test('preview README no longer claims fork PRs never execute on the mini', () => {
    const readme = read('selfhost/preview/README.md')
    expect(readme).not.toMatch(/Fork PRs[^\n]*never execute on the mini/)
    expect(readme).toContain('Never approve workflow runs for fork PRs')
    expect(readme).toContain('organization runner group')
  })
})

describe('self-host configuration', () => {
  test('docker compose defaults to digest-pinned ghcr.io/convex images', () => {
    const compose = read('selfhost/docker-compose.yml')
    expect(compose).toContain(`image: \${CONVEX_BACKEND_IMAGE:-${BACKEND_DIGEST}}`)
    expect(compose).toContain(`image: \${CONVEX_DASHBOARD_IMAGE:-${DASHBOARD_DIGEST}}`)
  })

  test.each([
    'selfhost/docker-compose.yml',
    'selfhost/.env.example',
    'selfhost/preview/config.example.env',
    'selfhost/preview/deploy-preview.sh',
    'selfhost/preview/slot-compose.yml',
    'selfhost/README.md',
  ])('%s references no image under the dead ghcr.io/get-convex path', (file) => {
    const active = read(file)
      .split('\n')
      .filter((line) => /ghcr\.io\/get-convex\/[\w-]+[:@]/.test(line))
    expect(active).toEqual([])
  })

  test('.env.example does not override the pinned images with a dead default', () => {
    expect(read('selfhost/.env.example')).not.toMatch(/^CONVEX_(BACKEND|DASHBOARD)_IMAGE=/m)
  })

  test('the tunnel targets the loopback address the services bind to', () => {
    const services = read('selfhost/cloudflared/config.example.yml')
      .split('\n')
      .filter((line) => /^\s*service: http/.test(line))
    expect(services).toEqual([
      '    service: http://127.0.0.1:3000',
      '    service: http://127.0.0.1:3210',
      '    service: http://127.0.0.1:3211',
    ])
    expect(read('selfhost/bin/start-app.sh')).toContain('export HOST="${HOST:-127.0.0.1}"')
  })

  test('launchd plists do not point into ~/Documents', () => {
    for (const plist of ['com.wepaintai.app.plist', 'com.wepaintai.backup.plist']) {
      const text = read(`selfhost/launchd/${plist}`)
      expect(text).not.toContain('/Documents/')
      expect(text).toContain('/apps/wepaintai/selfhost/bin/')
    }
  })

  test('backup.sh defaults to ~/apps/wepaintai', () => {
    expect(read('selfhost/bin/backup.sh')).toContain(
      'REPO_DIR="${WEPAINTAI_DIR:-$HOME/apps/wepaintai}"'
    )
  })

  const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0
  test.skipIf(!hasZsh)('backup.sh fails loudly when the Convex CLI is not installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-'))
    try {
      mkdirSync(join(dir, 'selfhost'))
      writeFileSync(join(dir, 'selfhost', '.env.convex'), '')
      const r = spawnSync('zsh', [join(REPO, 'selfhost/bin/backup.sh')], {
        encoding: 'utf8',
        env: { ...process.env, WEPAINTAI_DIR: dir, WEPAINTAI_BACKUP_DIR: join(dir, 'backups') },
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Convex CLI not installed')
      expect(r.stderr).toContain('corepack pnpm install --frozen-lockfile')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
