import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deactivateWithCleanup,
  isCurrentCoreBinding,
  loadOrCreateCoreCapability,
  trustedLocalCoreEndpoint,
} from '../extensions/vscode/src/lifecycle.js';
import { validateOriginReleaseEvent, validateReleaseLockUrls } from '../scripts/validate-vscode-release.mjs';

describe('VS Code extension lifecycle', () => {
  it('returns the async cleanup promise so VS Code waits for session deletion', async () => {
    let resolveCleanup!: () => void;
    let cleaned = false;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = () => {
        cleaned = true;
        resolve();
      };
    });

    const returned = deactivateWithCleanup(() => cleanup);
    let settled = false;
    returned.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleaned).toBe(false);

    resolveCleanup();
    await returned;
    expect(cleaned).toBe(true);
    expect(settled).toBe(true);
  });

  it('allows only trusted loopback core endpoints', () => {
    expect(trustedLocalCoreEndpoint('http://127.0.0.1:8015', true)).toBe('http://127.0.0.1:8015');
    expect(() => trustedLocalCoreEndpoint('http://127.0.0.1:8015', false)).toThrow(/Trust this workspace/);
    expect(() => trustedLocalCoreEndpoint('http://attacker.invalid:8015', true)).toThrow(/loopback-only/);
    expect(() => trustedLocalCoreEndpoint('https://127.0.0.1:8015', true)).toThrow(/loopback HTTP/);
  });

  it('creates one owner-only install capability and fences late A bindings from B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scli326-capability-'));
    const first = await loadOrCreateCoreCapability(root);
    const second = await loadOrCreateCoreCapability(root);
    expect(second).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(join(root, 'local-core.capability'))).mode & 0o777).toBe(0o600);

    const oldA = { generation: 4, sessionId: 'session-a', rootUri: 'file:///a' };
    const currentB = { generation: 5, sessionId: 'session-b', rootUri: 'file:///b' };
    expect(isCurrentCoreBinding(oldA, currentB)).toBe(false);
    expect(isCurrentCoreBinding(currentB, currentB)).toBe(true);
  });

  it('treats metacharacter refs as data and rejects them before any command can run', () => {
    const marker = join(tmpdir(), `scli326-ref-injection-${process.pid}`);
    const result = spawnSync(process.execPath, ['scripts/validate-vscode-release.mjs'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        RELEASE_REPOSITORY: 'shizuha-labs/shizuha',
        RELEASE_REF: 'refs/tags/vscode-v$(touch${IFS}' + marker + ')',
        RELEASE_SHA: 'a'.repeat(40),
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical master');
    expect(() => execFileSync('test', ['-e', marker])).toThrow();
  });

  it('enforces a closed, regular-file-only VSIX manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scli326-vsix-'));
    const tree = join(root, 'tree');
    await mkdir(join(tree, 'extension/dist/extensions/vscode/src'), { recursive: true });
    await mkdir(join(tree, 'extension/dist/src'), { recursive: true });
    await mkdir(join(tree, 'extension/images'), { recursive: true });
    await mkdir(join(tree, 'extension/media'), { recursive: true });
    const sha = 'b'.repeat(40);
    const packageManifest = JSON.parse(await readFile('extensions/vscode/package.json', 'utf8'));
    const xmlManifest = `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>
      <Identity Language="en-US" Id="shizuha-vscode" Version="0.1.0" Publisher="shizuha" />
      <DisplayName>Shizuha</DisplayName><Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.92.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/shizuha-labs/shizuha.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/shizuha-labs/shizuha.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/shizuha-labs/shizuha.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/shizuha-labs/shizuha/issues" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://shizuha.com" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="#4f46e5" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="dark" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
      </Properties><License>extension/LICENSE.txt</License><Icon>extension/images/icon.png</Icon></Metadata>
      <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation><Dependencies/><Assets>
      <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
      <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
      <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
      <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
      <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/icon.png" Addressable="true" />
      </Assets></PackageManifest>`;
    const files: Record<string, string> = {
      '[Content_Types].xml': '<Types/>',
      'extension.vsixmanifest': xmlManifest,
      'extension/LICENSE.txt': 'AGPL',
      'extension/SOURCE_SHA': `${sha}\n`,
      'extension/changelog.md': '# changes',
      'extension/dist/extensions/vscode/src/chat-state.js': '',
      'extension/dist/extensions/vscode/src/chat-webview.js': '',
      'extension/dist/extensions/vscode/src/extension.js': '',
      'extension/dist/extensions/vscode/src/file-diff.js': '',
      'extension/dist/extensions/vscode/src/lifecycle.js': '',
      'extension/dist/extensions/vscode/src/provider-settings.js': '',
      'extension/dist/extensions/vscode/src/run-monitor.js': '',
      'extension/dist/src/local-core-protocol.js': '',
      'extension/images/icon.png': 'png',
      'extension/media/chat.css': '',
      'extension/media/chat.js': '',
      'extension/package.json': JSON.stringify(packageManifest),
      'extension/readme.md': '# Shizuha',
    };
    for (const [name, content] of Object.entries(files)) {
      const target = join(tree, name);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    }
    const clean = join(root, 'clean.vsix');
    execFileSync('python3', ['scripts/repack-vscode-vsix.py', tree, clean, '315532800'], { cwd: resolve('.') });
    const cleanEvidence = execFileSync(process.execPath, ['scripts/verify-vscode-vsix.mjs', clean, sha, '0.1.0'], { cwd: resolve('.') });
    const renamed = join(root, 'renamed.vsix');
    await cp(clean, renamed);
    const renamedEvidence = execFileSync(process.execPath, ['scripts/verify-vscode-vsix.mjs', renamed, sha, '0.1.0'], { cwd: resolve('.') });
    expect(renamedEvidence).toEqual(cleanEvidence);

    const backdoorTree = join(root, 'backdoor');
    await cp(tree, backdoorTree, { recursive: true });
    await writeFile(join(backdoorTree, 'extension/backdoor.js'), 'malicious');
    await writeFile(join(backdoorTree, 'extension/.npmrc'), 'dummy-token');
    const backdoor = join(root, 'backdoor.vsix');
    execFileSync('python3', ['scripts/repack-vscode-vsix.py', backdoorTree, backdoor, '315532800'], { cwd: resolve('.') });
    expect(spawnSync(process.execPath, ['scripts/verify-vscode-vsix.mjs', backdoor, sha, '0.1.0'], {
      cwd: resolve('.'), encoding: 'utf8',
    }).status).not.toBe(0);

    const symlinkTree = join(root, 'symlink');
    await cp(tree, symlinkTree, { recursive: true });
    const symlinkVsix = join(root, 'symlink.vsix');
    const symlinkBuilder = [
      'import json,stat,sys,zipfile,pathlib',
      'root,out,names=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])',
      'z=zipfile.ZipFile(out,"w",compression=zipfile.ZIP_DEFLATED)',
      '[(lambda i,p:(setattr(i,"create_system",3),setattr(i,"external_attr",((stat.S_IFLNK|0o777)<<16)),setattr(i,"compress_type",zipfile.ZIP_DEFLATED),z.writestr(i,b"chat.css")))(zipfile.ZipInfo(n,(1980,1,1,0,0,0)),pathlib.Path(root,n)) if n=="extension/media/chat.js" else z.write(pathlib.Path(root,n),n) for n in names]',
      'z.close()',
    ].join(';');
    execFileSync('python3', ['-c', symlinkBuilder, symlinkTree, symlinkVsix, JSON.stringify(Object.keys(files))]);
    expect(spawnSync(process.execPath, ['scripts/verify-vscode-vsix.mjs', symlinkVsix, sha, '0.1.0'], {
      cwd: resolve('.'), encoding: 'utf8',
    }).status).not.toBe(0);

    const wrongIdentityTree = join(root, 'wrong-identity');
    await cp(tree, wrongIdentityTree, { recursive: true });
    await writeFile(join(wrongIdentityTree, 'extension/package.json'), JSON.stringify({
      ...packageManifest, publisher: 'shizuha', name: 'attacker-extension', version: '99.99.99',
      engines: { vscode: '^0.10.0' }, license: 'missing', icon: 'missing.png',
    }));
    const wrongIdentity = join(root, 'wrong-identity.vsix');
    execFileSync('python3', ['scripts/repack-vscode-vsix.py', wrongIdentityTree, wrongIdentity, '315532800'], { cwd: resolve('.') });
    expect(spawnSync(process.execPath, ['scripts/verify-vscode-vsix.mjs', wrongIdentity, sha, '0.1.0'], {
      cwd: resolve('.'), encoding: 'utf8',
    }).status).not.toBe(0);

    const rejectedMutations: Array<[string, (treePath: string) => Promise<void>]> = [
      ['comment-split-identity', async (treePath) => {
        const attackerManifest = xmlManifest.replace(
          '<Identity Language="en-US" Id="shizuha-vscode" Version="0.1.0" Publisher="shizuha" />',
          '<!-- <Identity Language="en-US" Id="shizuha-vscode" Version="0.1.0" Publisher="shizuha" /> -->\n' +
          '<Identity Language="en-US" Id="attacker" Version="99.0.0" Publisher="attacker" />',
        );
        await writeFile(join(treePath, 'extension.vsixmanifest'), attackerManifest);
      }],
      ['malformed-xml', async (treePath) => {
        await writeFile(join(treePath, 'extension.vsixmanifest'), xmlManifest.replace('</Metadata>', ''));
      }],
      ['target-platform', async (treePath) => {
        await writeFile(join(treePath, 'extension.vsixmanifest'), xmlManifest.replace(
          'Publisher="shizuha" />', 'Publisher="shizuha" TargetPlatform="linux-x64" />',
        ));
      }],
      ['package-policy', async (treePath) => {
        await writeFile(join(treePath, 'extension/package.json'), JSON.stringify({
          ...packageManifest,
          activationEvents: ['*'],
          extensionDependencies: ['attacker.extension'],
          enabledApiProposals: ['terminalDataWriteEvent'],
          homepage: 'https://attacker.invalid',
          contributes: {
            ...packageManifest.contributes,
            commands: [...packageManifest.contributes.commands, { command: 'attacker.hidden', title: 'Hidden' }],
          },
        }));
      }],
      ['unexpected-contribution', async (treePath) => {
        await writeFile(join(treePath, 'extension/package.json'), JSON.stringify({
          ...packageManifest,
          contributes: {
            ...packageManifest.contributes,
            debuggers: [{ type: 'shizuha-hidden', label: 'Unauthorized debugger', program: './dist/extension.js' }],
          },
        }));
      }],
    ];
    for (const [name, mutate] of rejectedMutations) {
      const mutationTree = join(root, name);
      await cp(tree, mutationTree, { recursive: true });
      await mutate(mutationTree);
      const candidate = join(root, `${name}.vsix`);
      execFileSync('python3', ['scripts/repack-vscode-vsix.py', mutationTree, candidate, '315532800'], { cwd: resolve('.') });
      expect(spawnSync(process.execPath, ['scripts/verify-vscode-vsix.mjs', candidate, sha, '0.1.0'], {
        cwd: resolve('.'), encoding: 'utf8',
      }).status, name).not.toBe(0);
    }
  });

  it('accepts only the exact canonical Origin master merge event', () => {
    const merge = 'c'.repeat(40);
    const parents = ['a'.repeat(40), 'b'.repeat(40)];
    expect(validateOriginReleaseEvent({
      repository: 'shizuha-labs/shizuha',
      ref: 'refs/heads/master',
      sha: merge,
      head: merge,
      parents,
    })).toMatchObject({ source_sha: merge, release_gate: 'origin-master-merge-build-evidence' });
    expect(() => validateOriginReleaseEvent({
      repository: 'shizuha-labs/shizuha', ref: 'refs/heads/main', sha: merge, head: merge, parents,
    })).toThrow(/canonical master/);
    expect(() => validateOriginReleaseEvent({
      repository: 'shizuha-labs/shizuha', ref: 'refs/heads/master', sha: merge, head: 'd'.repeat(40), parents,
    })).toThrow(/checkout/);
    expect(() => validateOriginReleaseEvent({
      repository: 'shizuha-labs/shizuha', ref: 'refs/heads/master', sha: merge, head: merge, parents: [parents[0]],
    })).toThrow(/merge commit/);
  });

  it('rejects release lockfiles that depend on mutable internal registry endpoints', () => {
    expect(() => validateReleaseLockUrls({
      packages: {
        'node_modules/example': {
          resolved: 'http://100.64.0.3:30512/example/-/example-1.0.0.tgz',
        },
      },
    }, 'fixture lock')).toThrow(/public npm registry/);
    expect(() => validateReleaseLockUrls({
      packages: {
        'node_modules/example': {
          resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
        },
      },
    }, 'fixture lock')).not.toThrow();
  });
});
