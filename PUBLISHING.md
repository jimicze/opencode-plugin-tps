# Publishing an OpenCode TUI Plugin to npm

Step-by-step guide for publishing a TUI (sidebar) plugin to npm and registering it in the OpenCode ecosystem.

---

## Prerequisites

- Node.js >= 18
- An [npm account](https://www.npmjs.com)
- A GitHub repository (public)
- OpenCode with TUI plugin support

---

## Step 1: Package Structure

OpenCode TUI plugins need a specific `package.json` layout.

### Required fields

| Field | Value | Why |
|-------|-------|-----|
| `name` | `@your-scope/opencode-*` | npm naming convention. Use a scoped package (requires npm org). |
| `type` | `"module"` | OpenCode loads plugins as ESM. |
| `exports` | `{ "./tui": { "import": "./path/to/plugin.tsx" } }` | The `./tui` export is how OpenCode discovers the TUI entrypoint. |
| `engines.opencode` | `"^1.0.0"` | Documents minimum OpenCode version. |
| `publishConfig.access` | `"public"` | Scoped packages default to private — this makes them public. |
| `files` | `[...]` | Allowlist of files in the tarball. Prevents leaking tests, config, docs. |

### Minimal `package.json`

```json
{
  "name": "@your-scope/opencode-your-plugin",
  "version": "0.1.0",
  "description": "One-line description of your plugin",
  "type": "module",
  "exports": {
    "./tui": {
      "import": "./src/plugin.tsx"
    }
  },
  "engines": {
    "opencode": "^1.0.0"
  },
  "license": "MIT",
  "author": "your-name",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/you/opencode-your-plugin.git"
  },
  "homepage": "https://github.com/you/opencode-your-plugin#readme",
  "bugs": {
    "url": "https://github.com/you/opencode-your-plugin/issues"
  },
  "keywords": ["opencode", "plugin"],
  "publishConfig": {
    "access": "public"
  },
  "files": [
    "src"
  ]
}
```

> npm always includes `package.json`, `README.md`, and `LICENSE` regardless of the `files` field.

### Plugin entry point

The TUI entry file must export a default module with `id` and `tui`:

```typescript
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api, options, meta) => {
  api.slots.register({
    slot: "sidebar_content",
    order: 150,
    render: () => <box><text>My Plugin</text></box>,
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "my-plugin-id",
  tui,
}

export default plugin
```

**Key points:**
- `id` is the plugin identifier registered in OpenCode's plugin metadata
- `tui` is the initialization function — it receives `TuiPluginApi` with `api.slots`, `api.event`, `api.keymap`, `api.route`, `api.theme`, `api.kv`, etc.
- The `/** @jsxImportSource @opentui/solid */` pragma is required for Solid JSX

---

## Step 2: Create an npm Organization

Scoped packages (`@org/package`) require either a user scope or an organization.

1. Go to [npmjs.com](https://www.npmjs.com) → click avatar → **Add Organization**
2. Choose a name (e.g., `@your-scope`)
3. Select **Unlimited public packages** (free tier)
4. Verify your email if prompted

> If the scope matches your npm username exactly, you don't need an organization — your user account is the scope.

---

## Step 3: Verify Before Publishing

```bash
# Run tests
npm test

# Type-check
npm run typecheck

# Dry run — list every file that would be in the tarball
npm pack --dry-run
```

Expected output should show only: your entry file(s), `package.json`, `README.md`, `LICENSE`.

---

## Step 4: Publish

```bash
# First publish
npm publish --access public

# Subsequent publishes (version must be bumped)
npm publish
```

### First publish flow

`npm publish --access public` will:
1. Prompt you to authenticate via browser (OAuth)
2. Upload the package to the npm registry
3. Output `+ @your-scope/opencode-your-plugin@0.1.0`

### Version bumps

```bash
# Patch (0.1.0 → 0.1.1)
npm version patch

# Minor (0.1.0 → 0.2.0)
npm version minor

# Major (0.1.0 → 1.0.0)
npm version major
```

Each bumps `package.json`, creates a git tag, and requires `git push --tags`.

---

## Step 5: Post-Publish Verification

```bash
# View package metadata
npm view @your-scope/opencode-your-plugin

# Check all published versions
npm info @your-scope/opencode-your-plugin versions
```

Also check:
- **Package page** at `https://www.npmjs.com/package/@your-scope/opencode-your-plugin`
- **Files tab** shows only what you expect
- **README renders correctly** (npm caches — may take a minute)
- **Smoke test** in a fresh project

---

## Step 6: Register in awesome-opencode

The [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) registry is the community directory of OpenCode extensions.

### Fork and clone

```bash
gh repo fork awesome-opencode/awesome-opencode --clone
cd awesome-opencode
```

### Create the YAML entry

Create `data/plugins/your-plugin.yaml`:

```yaml
name: "@your-scope/opencode-your-plugin"
repo: https://github.com/you/opencode-your-plugin
tagline: Short description (max 120 chars)
description: |
  Longer description explaining what your plugin does.

  Features:
  - Feature one
  - Feature two

  Install via npm:
  ```json
  { "plugin": ["@your-scope/opencode-your-plugin"] }
  ```
```

**Required fields:** `name`, `repo`, `tagline`, `description`
**Optional fields:** `scope`, `tags`, `min_version`, `homepage`, `installation`

### Submit PR

```bash
git checkout -b add-your-plugin
git add data/plugins/your-plugin.yaml
git commit -m "docs: add @your-scope/opencode-your-plugin to plugins"
git push origin add-your-plugin

gh pr create --repo awesome-opencode/awesome-opencode \
  --title "docs: add @your-scope/opencode-your-plugin" \
  --body "Adds [@your-scope/opencode-your-plugin](https://github.com/you/opencode-your-plugin)..."
```

### How entries are rendered

Each YAML entry generates a collapsible `<details>` section in the auto-built README. No manual README editing needed — the build script regenerates it from YAML data.

---

## Step 7: Get Listed on OpenCode's Ecosystem Page

The official [Ecosystem page](https://opencode.ai/docs/ecosystem) is maintained at:

`packages/web/src/content/docs/ecosystem.mdx` in the [anomalyco/opencode](https://github.com/anomalyco/opencode) repo.

To add your plugin:

1. Fork `anomalyco/opencode`
2. Edit `packages/web/src/content/docs/ecosystem.mdx`
3. Add a row to the Plugins table:

```markdown
| [@your-scope/opencode-your-plugin](https://github.com/you/opencode-your-plugin) | What your plugin does in one line |
```

4. Submit a PR

---

## Step 8: Automated Publishing with GitHub Actions (Optional)

For tag-triggered releases with provenance attestation:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags:
      - 'v*'
permissions:
  contents: write
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - name: Verify tag matches version
        run: |
          [ "$(echo $GITHUB_REF | sed 's|refs/tags/v||')" = "$(node -p "require('./package.json').version")" ]
      - name: Test
        run: npm test
      - name: Publish
        run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Before this works, configure **Trusted Publishing** on npm:
1. Go to your package page on npmjs.com → **Settings**
2. Scroll to **Trusted Publishers** → **Add a Trusted Publisher**
3. Enter your GitHub org, repo, and workflow filename (`release.yml`)

---

## Quick Reference Checklist

```
[ ] Tests pass (npm test)
[ ] Type-check passes (npm run typecheck)
[ ] package.json has correct name, exports, and files
[ ] Plugin exports default { id, tui }
[ ] Tarball verified (npm pack --dry-run)
[ ] Published to npm (npm publish --access public)
[ ] Package visible on npmjs.com
[ ] PR submitted to awesome-opencode
[ ] PR submitted to opencode ecosystem page (optional)
```

---

## Troubleshooting

| Error | Likely cause | Fix |
|-------|-------------|-----|
| `404 Scope not found` | npm org doesn't exist | Create the org at npmjs.com |
| `402 Payment Required` | Scoped package defaulting to private | Add `"publishConfig": { "access": "public" }` |
| `404 Not Found` on publish | Missing npm org or wrong scope | Verify org exists and matches package name |
| `403 2FA required` | npm account has 2FA | Use a Granular Access Token with "bypass 2FA" |
| `Cannot find module '@opencode-ai/plugin/tui'` | Missing runtime dep | Don't install it — OpenCode provides it at runtime |
| Plugin not showing in sidebar | Wrong `exports` path in package.json | Verify `exports["./tui"]` points to the correct file |
