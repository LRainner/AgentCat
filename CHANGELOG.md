# Changelog

## [1.9.1](https://github.com/LRainner/AgentCat/compare/v1.9.0...v1.9.1) (2026-08-15)


### Bug Fixes

* **dsh:** mark standalone context compaction as manual ([#48](https://github.com/LRainner/AgentCat/issues/48)) ([c548f62](https://github.com/LRainner/AgentCat/commit/c548f62f6b8818b788ec4261ea6b2de3014b96c9))

## [1.9.0](https://github.com/LRainner/AgentCat/compare/v1.8.0...v1.9.0) (2026-08-15)


### Features

* **dsh:** integrate DeepSeek Harness ([#46](https://github.com/LRainner/AgentCat/issues/46)) ([917d863](https://github.com/LRainner/AgentCat/commit/917d863300b563a94970ff1891ffb5dd6c9af7b1))

## [1.8.0](https://github.com/LRainner/AgentCat/compare/v1.7.0...v1.8.0) (2026-08-07)


### Features

* **i18n:** add English and Chinese localization ([#44](https://github.com/LRainner/AgentCat/issues/44)) ([1594d3e](https://github.com/LRainner/AgentCat/commit/1594d3e2c40f4c7c45af6a7e9507f7c7cf400cba))
* **status:** allow dismissing live bubbles ([#42](https://github.com/LRainner/AgentCat/issues/42)) ([5c91d5e](https://github.com/LRainner/AgentCat/commit/5c91d5efad387b03a757d68551c4c1344172cc01))

## [1.7.0](https://github.com/LRainner/AgentCat/compare/v1.6.0...v1.7.0) (2026-08-05)


### Features

* **status:** show agent source in live bubbles ([#39](https://github.com/LRainner/AgentCat/issues/39)) ([9aad9c3](https://github.com/LRainner/AgentCat/commit/9aad9c324414105cdca16881b212195306b1001c))


### Bug Fixes

* **claude:** detect interrupted turns reliably ([#41](https://github.com/LRainner/AgentCat/issues/41)) ([5493c2b](https://github.com/LRainner/AgentCat/commit/5493c2b51d5595c0b0fffb27e7189067ab07dbc3))

## [1.6.0](https://github.com/LRainner/AgentCat/compare/v1.5.2...v1.6.0) (2026-08-04)


### Features

* add Claude Code integration and unified agent settings ([#37](https://github.com/LRainner/AgentCat/issues/37)) ([f8a15bb](https://github.com/LRainner/AgentCat/commit/f8a15bbf3c468ea180a205707202e612ff1a0877))

## [1.5.2](https://github.com/LRainner/AgentCat/compare/v1.5.1...v1.5.2) (2026-08-01)


### Bug Fixes

* **settings:** use native pet paths and refine position reset ([#35](https://github.com/LRainner/AgentCat/issues/35)) ([cf429bd](https://github.com/LRainner/AgentCat/commit/cf429bd316accbd947513952c986bf4edb5ec57e))
* **updater:** keep update indicator until install ([#33](https://github.com/LRainner/AgentCat/issues/33)) ([5265901](https://github.com/LRainner/AgentCat/commit/5265901b59b181a62424d7275b6d3ff908efed47))
* **window:** stabilize pet dragging and decouple agent integrations ([#36](https://github.com/LRainner/AgentCat/issues/36)) ([4347640](https://github.com/LRainner/AgentCat/commit/43476405cd1d46833d9ff00cd841fc62dbc94ca0))

## [1.5.1](https://github.com/LRainner/AgentCat/compare/v1.5.0...v1.5.1) (2026-07-30)


### Bug Fixes

* **codex:** detect completed review turns ([#32](https://github.com/LRainner/AgentCat/issues/32)) ([fe62ef1](https://github.com/LRainner/AgentCat/commit/fe62ef152d456600c21324ec13f92bfe208dfd27))
* **window:** focus settings on first open ([#30](https://github.com/LRainner/AgentCat/issues/30)) ([16b8390](https://github.com/LRainner/AgentCat/commit/16b83901566140cd26beb95577c3fb67785c4f78))

## [1.5.0](https://github.com/LRainner/AgentCat/compare/v1.4.0...v1.5.0) (2026-07-30)


### Features

* **status:** improve live status feedback ([#26](https://github.com/LRainner/AgentCat/issues/26)) ([94898cd](https://github.com/LRainner/AgentCat/commit/94898cd9a546bea6b5dc6243b9b33a9b4dd69358))
* **updater:** add background update indicator ([#29](https://github.com/LRainner/AgentCat/issues/29)) ([22b85eb](https://github.com/LRainner/AgentCat/commit/22b85eb3d48a821ce54565220846b714f32fc441))


### Bug Fixes

* **codex:** persist hook verification status ([#28](https://github.com/LRainner/AgentCat/issues/28)) ([c8eded8](https://github.com/LRainner/AgentCat/commit/c8eded80b3ceef01d6daaf72372d1f17fbc6c29b))

## [1.4.0](https://github.com/LRainner/AgentCat/compare/v1.3.0...v1.4.0) (2026-07-28)


### Features

* **codex:** detect interrupted session lifecycle ([#23](https://github.com/LRainner/AgentCat/issues/23)) ([662ccfc](https://github.com/LRainner/AgentCat/commit/662ccfc2ca39edf5da23ad9d00e229dc1ecfe72f))

## [1.3.0](https://github.com/LRainner/AgentCat/compare/v1.2.5...v1.3.0) (2026-07-27)


### Features

* **status:** stack concurrent session status bubbles ([#20](https://github.com/LRainner/AgentCat/issues/20)) ([e1a888b](https://github.com/LRainner/AgentCat/commit/e1a888b131d6a66d998406f27c59c33083f7674d))


### Bug Fixes

* **windows:** avoid deadlock when opening windows ([#22](https://github.com/LRainner/AgentCat/issues/22)) ([f1d753c](https://github.com/LRainner/AgentCat/commit/f1d753c27a42bd2ea73509819d9481c0a485e3a7))

## [1.2.5](https://github.com/LRainner/AgentCat/compare/v1.2.4...v1.2.5) (2026-07-27)


### Bug Fixes

* **status:** refine bubble contrast and shadow ([#18](https://github.com/LRainner/AgentCat/issues/18)) ([22fa80e](https://github.com/LRainner/AgentCat/commit/22fa80e4d028ff66f07ad6ebf259db969e59423b))

## [1.2.4](https://github.com/LRainner/AgentCat/compare/v1.2.3...v1.2.4) (2026-07-27)


### Bug Fixes

* **ci:** generate stable updater download URLs ([#16](https://github.com/LRainner/AgentCat/issues/16)) ([e08322f](https://github.com/LRainner/AgentCat/commit/e08322f89265448b1856f47c75c832270e19edd5))

## [1.2.3](https://github.com/LRainner/AgentCat/compare/v1.2.2...v1.2.3) (2026-07-26)


### Bug Fixes

* **ci:** download draft release signatures via API ([#14](https://github.com/LRainner/AgentCat/issues/14)) ([e4a69ee](https://github.com/LRainner/AgentCat/commit/e4a69ee0a2f75ea1ff21e26932d9afe4a43e65fc))

## [1.2.2](https://github.com/LRainner/AgentCat/compare/v1.2.1...v1.2.2) (2026-07-26)


### Bug Fixes

* **ci:** publish complete releases atomically ([#12](https://github.com/LRainner/AgentCat/issues/12)) ([49be2b5](https://github.com/LRainner/AgentCat/commit/49be2b5338d9b462369e0a445ef755af1ca48b91))

## [1.2.1](https://github.com/LRainner/AgentCat/compare/v1.2.0...v1.2.1) (2026-07-26)


### Bug Fixes

* **updater:** honor native system proxy settings ([#10](https://github.com/LRainner/AgentCat/issues/10)) ([6992160](https://github.com/LRainner/AgentCat/commit/69921601d1d170e2e5430f42669b36c1b35b03c9))

## [1.2.0](https://github.com/LRainner/AgentCat/compare/v1.1.0...v1.2.0) (2026-07-26)


### Features

* add in-app updater and settings navigation ([#9](https://github.com/LRainner/AgentCat/issues/9)) ([a8fc772](https://github.com/LRainner/AgentCat/commit/a8fc772567b72e996ef44fdc715fdc833c665564))
* **windows:** allow choosing installation scope ([#7](https://github.com/LRainner/AgentCat/issues/7)) ([8a58ef5](https://github.com/LRainner/AgentCat/commit/8a58ef5e0b5d005956133948104d8d669d5f63df))

## [1.1.0](https://github.com/LRainner/AgentCat/compare/v1.0.0...v1.1.0) (2026-07-26)


### Features

* add Windows support ([9811c71](https://github.com/LRainner/AgentCat/commit/9811c7157cf8714438d3879f4cb7aba3df4f98cd))

## [1.0.0](https://github.com/LRainner/AgentCat/compare/v0.3.3...v1.0.0) (2026-07-24)


### Features

* add Agent Cat desktop companion with Codex integration ([54d7288](https://github.com/LRainner/AgentCat/commit/54d7288e35ba19ddb6ccc92e6e13809ad711035f))


### Continuous Integration

* automate draft GitHub releases ([7184c1d](https://github.com/LRainner/AgentCat/commit/7184c1dd02ba263f1f7d45344e84ba81da4e5f31))
