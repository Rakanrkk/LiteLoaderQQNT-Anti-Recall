# Source provenance

This is a development fork of [xh321/LiteLoaderQQNT-Anti-Recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall), retaining its original Git history and [MIT license](LICENSE).

The macOS compatibility baseline is ported from the public plugin payload in [ChrisYP/LiteLoaderQQNT-macOS-AntiRecall](https://github.com/ChrisYP/LiteLoaderQQNT-macOS-AntiRecall/tree/56d6b0c86f285ff36d32cd5c3036d38b78d775b2/payload/LiteLoaderQQNT/plugins/qq-anti-recall), commit `56d6b0c86f285ff36d32cd5c3036d38b78d775b2`. That project's README identifies the plugin as an Anti-Recall 0.3.0 derivative and credits the MIT-licensed upstream. It does not contain a separate root license for its additional installer and compatibility code; this provenance note does not create a new license grant for that code.

The port includes background message capture, bounded image preservation, persistence recovery and synthetic tests. The bundled `node_modules` patch is not copied: this fork explicitly depends on `level` 7 for the macOS main-process database and retains `level-party` for other platforms.

LiteLoaderQQNT itself, QQ binaries, third-party dependency source trees, account data, message databases, images, credentials, local backups and runtime logs are not included in this repository. Installation requires an existing compatible LiteLoaderQQNT setup.
