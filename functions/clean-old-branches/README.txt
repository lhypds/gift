clean-old-branches
==================


Delete the local branches in the current git repository that are not on the remote.


Files
-----

| File                 | Description                                                                |
|----------------------|----------------------------------------------------------------------------|
| `main.js`            | Core logic script — run through `gift clean-old-branches`, or directly with node |
| `main.test.js`       | Tests, against throwaway repositories — run with `node --test`             |
| `config.schema.json` | The settings this function has — see `functions.clean-old-branches` in config.json |


Usage
-----

```bash
gift clean-old-branches [options]
```

(`gift clean` is enough of the name.)

Run it inside a repository. The remote is asked which branches it has with
`git ls-remote`, rather than read from the `origin/*` refs, which are only as
fresh as the last fetch — so there is nothing to fetch or prune first. Every
local branch that is not there is listed with why:

    gone from origin   it tracked a branch on origin that has since been
                       deleted, as GitHub does when a pull request is merged
    no upstream        it tracks nothing and nothing of its name is on origin —
                       usually a branch that was never pushed

and nothing is deleted until you answer `y`.

A branch counts as on the remote when a branch of the same name is there, or the
branch it tracks is. Some that are not on it are kept anyway, and listed with why:

    checked out here           git will not delete the branch a worktree is on
    checked out in PATH
    tracks upstream/NAME       it follows another remote, which was not asked

A remote that answers with no branches at all is refused rather than taken at its
word: every local branch would go, and a wrong URL or a repository nothing has
been pushed to yet answers exactly that.


Parameters
----------

| Parameter                  | Description                                     | Default           |
|----------------------------|-------------------------------------------------|-------------------|
| `-r`, `--remote=NAME`      | The remote to compare the local branches with   | the configured `remote`, else `origin`, else the only remote |
| `-y`, `--yes`              | Delete without asking                           | off               |
| `-n`, `--dry-run`          | List what would be deleted, without deleting it | off               |
| `-h`, `--help`             | Show the help message and exit                  |                   |

`remote` is set under `functions.clean-old-branches` in config.json (`gift config`
opens it) and reaches the script as `GIFT_CLEAN_BRANCHES_REMOTE`. A flag wins over
it.

Without a terminal to ask in — a hook, a pipe — it needs `--yes`, and stops
without deleting anything otherwise.


Examples
--------

```bash
# See what would go
gift clean-old-branches --dry-run

# List them, then delete once you answer y
gift clean-old-branches

# Compare with a remote other than origin, and do not ask
gift clean-old-branches --remote=upstream --yes
```


Getting a branch back
---------------------

Branches are deleted with `git branch -D`, so one whose work was never merged
anywhere goes too. Each is printed with the commit it was on as it is deleted:

      deleted  spike  was d4e5f6a

and `git branch spike d4e5f6a` makes it again — for as long as git has not
garbage-collected the commit, which is weeks rather than forever.


Exit status
-----------

0     the branches were deleted, there was nothing to delete, or the answer was no
1     a branch could not be deleted, or the remote could not be asked
2     a wrong option, not a repository, no remote to use, or nobody to ask and no --yes
130   Ctrl-C or Ctrl-D at the question


Requirements
------------

- `git` 2.23 or newer — must be installed and available in PATH
