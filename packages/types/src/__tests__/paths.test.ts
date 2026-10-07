import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInside, PathEscapeError } from '../paths.js';

// ORACLE (D-11/D-22; A2-4 "`../` traversal,
// absolute escape and symlink escape are all refused").
//
// These are the primitive's own tests. The tools that use it and the policy engine that uses it
// each assert their half of the same guarantee; this file asserts the part neither can reach
// without contriving a filesystem — a symbolic link that leaves the root, a link whose target
// does not exist, and a directory whose name merely starts with the root's.

/**
 * A scratch root with one file in it, and a sibling directory whose name extends the root's
 * (`<root>-evil`). That sibling is what a `startsWith(root)` check gets wrong, so it has to
 * exist for the separator-aware test to mean anything.
 */
async function scratch(body: (dir: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(path.join(tmpdir(), 'maf-paths-'));
  const dir = path.join(parent, 'root');
  await mkdir(dir);
  await writeFile(path.join(dir, 'inside.txt'), 'inside\n', 'utf8');
  try {
    await body(dir);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('a path inside the root is returned in both forms, resolved', async () => {
  await scratch(async (dir) => {
    const real = await resolveInside(dir, 'inside.txt');
    assert.equal(real.absolute, path.join(await realRootOf(dir), 'inside.txt'));
    assert.equal(real.relative, 'inside.txt');
    assert.equal(real.root, await realRootOf(dir));
  });
});

test('every spelling of the same in-root file collapses to one relative path', async () => {
  // This is the half of D-11 that made a glob useless: `**/.env*` matched `.env` and not
  // `./.env` or `a/../.env`, so the *spelling* decided whether a Deny rule fired.
  await scratch(async (dir) => {
    for (const spelling of ['inside.txt', './inside.txt', 'sub/../inside.txt', './/inside.txt']) {
      assert.equal((await resolveInside(dir, spelling)).relative, 'inside.txt',
        `${JSON.stringify(spelling)} is the same file as "inside.txt"`);
    }
  });
});

test('the root itself is a legal path, with an empty relative form', async () => {
  await scratch(async (dir) => {
    for (const spelling of ['.', '']) {
      const here = await resolveInside(dir, spelling);
      assert.equal(here.relative, '');
      assert.equal(here.absolute, await realRootOf(dir));
    }
  });
});

test('a path that does not exist yet resolves, so a write target can be checked', async () => {
  // `realpath` alone refuses this, which is why the naive check would have to be skipped for
  // every `fs.write` — and skipping it for writes is precisely the hole.
  await scratch(async (dir) => {
    const toBe = await resolveInside(dir, 'new/deeper/file.txt');
    assert.equal(toBe.relative, 'new/deeper/file.txt');
  });
});

test('a sibling directory whose name extends the root is not inside it', async () => {
  await scratch(async (dir) => {
    // `<root>-evil` shares the root's prefix as a string and is a different directory.
    await assert.rejects(
      () => resolveInside(dir, '../root-evil/file.txt'),
      PathEscapeError,
      'a prefix test on the string would have called this inside',
    );
  });
});

test('a relative traversal out of the root is refused', async () => {
  await scratch(async (dir) => {
    for (const escape of ['../outside.txt', '../../etc/passwd', 'sub/../../outside.txt']) {
      await assert.rejects(() => resolveInside(dir, escape), PathEscapeError, escape);
    }
  });
});

test('an absolute path out of the root is refused', async () => {
  await scratch(async (dir) => {
    await assert.rejects(() => resolveInside(dir, '/etc/passwd'), PathEscapeError);
    await assert.rejects(() => resolveInside(dir, path.join(tmpdir(), 'outside.txt')), PathEscapeError);
  });
});

test('a symbolic link out of the root is refused, though its name is inside', async () => {
  await scratch(async (dir) => {
    const outside = path.join(path.dirname(dir), 'outside.txt');
    await writeFile(outside, 'secret\n', 'utf8');
    await symlink(outside, path.join(dir, 'link.txt'));

    // `dir/link.txt` is lexically inside the root and opens the file outside it. Only a
    // resolution of the link can tell the two apart.
    await assert.rejects(() => resolveInside(dir, 'link.txt'), PathEscapeError);
    await assert.rejects(() => resolveInside(dir, 'link.txt/extra'), PathEscapeError);
  });
});

test('a dangling symbolic link out of the root is refused', async () => {
  // The case a "resolve the nearest existing ancestor and append" shortcut gets wrong: the link
  // itself is not missing to `lstat`, but its target is, so appending the name would confirm a
  // confinement that opening it does not honour.
  await scratch(async (dir) => {
    await symlink(path.join(path.dirname(dir), 'not-there.txt'), path.join(dir, 'dangling.txt'));

    await assert.rejects(() => resolveInside(dir, 'dangling.txt'), PathEscapeError);
  });
});

test('a symbolic link that stays inside the root is allowed, resolved', async () => {
  // The control. Without it, "refuses links" and "refuses a link that leaves the root" would be
  // indistinguishable, and the function could be passing by refusing everything.
  await scratch(async (dir) => {
    await symlink(path.join(dir, 'inside.txt'), path.join(dir, 'alias.txt'));

    const alias = await resolveInside(dir, 'alias.txt');
    assert.equal(alias.relative, 'inside.txt', 'the link resolves to the file it points at');
    assert.equal(alias.absolute, path.join(await realRootOf(dir), 'inside.txt'));
  });
});

test('a symbolic link cycle is reported rather than followed forever', async () => {
  await scratch(async (dir) => {
    await symlink(path.join(dir, 'b.txt'), path.join(dir, 'a.txt'));
    await symlink(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));

    await assert.rejects(() => resolveInside(dir, 'a.txt'), /Too many symbolic links/);
  });
});

/** The root as the filesystem sees it — `TMPDIR` on macOS is reached through a symlink. */
async function realRootOf(dir: string): Promise<string> {
  return realpath(dir);
}
