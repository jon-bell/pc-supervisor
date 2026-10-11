# Comment classifier: model, licence, setup, measurements

The design is in [spec.md §5e](spec.md). This page records the pinned model, its licence, how the chair installs it, and what was measured.

## The model

| | |
|---|---|
| Model | all-MiniLM-L6-v2 (sentence-transformers), quantized ONNX conversion by Xenova |
| Source | `https://huggingface.co/Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9` |
| Licence | Apache-2.0 (both `sentence-transformers/all-MiniLM-L6-v2` and the `Xenova/all-MiniLM-L6-v2` conversion) |
| Output | 384-dimensional sentence embeddings (mean pooling, L2-normalized), inputs truncated at 256 tokens |
| Runtime | `onnxruntime-node` 1.30.0 (MIT; prebuilt CPU binaries for Linux, macOS and Windows ship in the package) and `@huggingface/tokenizers` 0.2.0 (Apache-2.0; pure JS) |

The weights are **not** in the repo and are never downloaded by the app, CI or tests. The chair installs them once into `PCS_MODEL_DIR` (default `data/models`, gitignored). Pinned files (`server/src/classifier/model-files.ts`):

| File | Bytes | sha256 |
|---|---|---|
| `onnx/model_quantized.onnx` | 22,972,370 | `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` |
| `tokenizer.json` | 711,661 | `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` |
| `tokenizer_config.json` | 366 | `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3` |
| `config.json` | 650 | `7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7` |

## Setup (chair-run, once)

```bash
npm run pcs -- model fetch      # plain GETs of the four pinned files; sha256-checked; sends nothing
# or, with files you downloaded yourself (a directory, or a .tar / .tar.gz):
npm run pcs -- model install ~/Downloads/all-MiniLM-L6-v2.tar.gz
npm run pcs -- model status     # installed, sha256 verified?
export PCS_COMMENT_CLASSIFIER=model
npm run pcs -- classify         # or just the next sync
```

The Hugging Face URLs redirect to its CDN; what is installed is decided by the pinned sha256, not the URL. A file whose size or hash differs is not installed. Until every file verifies, `PCS_COMMENT_CLASSIFIER=model` uses the heuristic and the UI says so.

Why `onnxruntime-node` + `@huggingface/tokenizers` and not `@huggingface/transformers`: transformers.js wraps the same `onnxruntime-node`, but also pulls in `sharp` (a native image library), `onnxruntime-web` (WebAssembly builds) and a Hub download layer the app would have to switch off (`env.allowRemoteModels = false`). With the two smaller packages there is no download code in the inference path at all: the app reads the files and hands the runtime bytes. Neither needs an install script, so `npm ci` works with `.npmrc`'s `ignore-scripts=true` (`onnxruntime-node`'s postinstall only fetches optional CUDA libraries).

## Accuracy on held-out synthetic data

`npm run pcs -- model accuracy`. The synthetic set (`server/src/classifier/synthetic.ts`) has 360 invented comments per class. Every 5th template of each class is held out, so the test texts have sentence shapes the head never saw (n = 286). The hard set is 25 hand-written comments per class in other styles, used only for testing (n = 100). For the model, the head is trained on the training templates only. Rows are the true type, columns the prediction.

Heuristic, held-out templates (99.3%):

```
truth \ pred     ping    reply     disc   nonsub
    ping       72        0        0        0
   reply        0       70        0        0
    disc        2        0       69        0
  nonsub        0        0        0       73
```

Heuristic, hard set (52.0%):

```
truth \ pred     ping    reply     disc   nonsub
    ping       10        0       15        0
   reply        0        5       20        0
    disc        0        0       25        0
  nonsub        0        0       13       12
```

Model, held-out templates (92.7%):

```
truth \ pred     ping    reply     disc   nonsub
    ping       64        7        1        0
   reply        0       60       10        0
    disc        0        2       69        0
  nonsub        1        0        0       72
```

Model, hard set (81.0%):

```
truth \ pred     ping    reply     disc   nonsub
    ping       15        4        5        1
   reply        0       22        1        2
    disc        0        5       20        0
  nonsub        0        1        0       24
```

The heuristic's patterns were written alongside the templates, so its template score says little; on the hard set it falls back to "discussion" for anything it doesn't recognise. The model generalises much better. Both are measured on invented text only: real discussions will differ, which is what the chair's relabels are for.

## Throughput

`npm run pcs -- model bench --n 10000`: 10,000 synthetic comments over 2,500 papers in an in-memory store, end to end (features from SQL, inference in the worker thread, the head, writes). AMD EPYC 7H12, 9 vCPUs, 4 ONNX threads:

| Classifier | 10,000 comments |
|---|---|
| heuristic | 1.3 s (~7,500/s) |
| model, first run | 42.6 s (~235/s), including embedding the 1,440 synthetic training texts and training the head |

After the first run only new or edited comments are embedded; a relabel retrains the head (well under a second) and re-predicts every comment from cached embeddings without inference.
