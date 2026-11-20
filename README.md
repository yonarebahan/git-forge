# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yonarebahan/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yonarebahan/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An in-memory GitHub-compatible forge with git smart HTTP, REST, GraphQL, and MCP sharing one repository store. It implements git objects, packfiles, branch ancestry, and squash merges directly with the Node standard library, using deterministic identifiers and a logical clock.

## Run it

```sh
# Node 22.18 or later; no installation step and no dependencies.
MAKEFUN_SHOP_TOKEN=local-development-token node main.ts
# The server binds an ephemeral port and prints it. Every API and git request must
# carry the same token as "Authorization: Bearer <token>"; the token owns the
# seeded viewer adaiversen. Under the make.fun suite, MAKEFUN_ENV_URL also names
# the env origin: the forge registers its port there and exits when told it is done.
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=xfpj6tfz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
