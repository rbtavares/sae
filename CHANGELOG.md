# Changelog

## [1.1.0](https://github.com/lighthouse-engineering/sae/compare/v1.0.0...v1.1.0) (2026-09-14)

### Features

* add Solana support via per-chain RPC family ([03d1e7a](https://github.com/lighthouse-engineering/sae/commit/03d1e7a0547ccfd6480b3ae69778a3c9697cefc3))

## 1.0.0 (2026-07-29)

### Features

* add server entrypoint and HTTP/WS routing ([13f1ca5](https://github.com/lighthouse-engineering/sae/commit/13f1ca56af5b9c7b86a12123b221f42a91586366))
* **config:** load chains from external JSON with schema validation ([0d99f17](https://github.com/lighthouse-engineering/sae/commit/0d99f170493c954e64db4807580abceb0903ba06))
* **core:** add HTTP JSON-RPC load balancer ([a56276e](https://github.com/lighthouse-engineering/sae/commit/a56276e170f0f821db8429bc346d498d9605649d))
* **core:** add per-upstream circuit breaker ([ff3bb04](https://github.com/lighthouse-engineering/sae/commit/ff3bb04ed2e0049f8e33d7b3c195549dcf9a07d2))
* **core:** add WebSocket RPC upstream support ([fcca974](https://github.com/lighthouse-engineering/sae/commit/fcca974a5199496fdca07e0363d262fb26676c81))
* **stats:** add rolling metrics ([645d79e](https://github.com/lighthouse-engineering/sae/commit/645d79e0e3d63fdb06d796ed6fa7f8d854df9f4f))
* **tui:** add global stats page with merged log stream ([dd13ff1](https://github.com/lighthouse-engineering/sae/commit/dd13ff15427bb1c915df4d93fce3901f05369ffc))
* **tui:** add split-screen terminal dashboard ([d2d1c3e](https://github.com/lighthouse-engineering/sae/commit/d2d1c3ec2ec1728455b3e8b9b2b2c45ba91fb6cf))
* **tui:** equalize tile heights, fix graph colors, sort upstreams ([10b45c2](https://github.com/lighthouse-engineering/sae/commit/10b45c2565c1ab6426138b24b471448e7fdb0243))

### Bug Fixes

* defer TUI start until server binds ([b925096](https://github.com/lighthouse-engineering/sae/commit/b9250966b7012fb996cf7d75acae24a60a145c4f))
* **dev:** forward CLI args through dev script ([4c9e7ec](https://github.com/lighthouse-engineering/sae/commit/4c9e7ec00d8824bf63b8cd64aa18816f47f5d4f8))
