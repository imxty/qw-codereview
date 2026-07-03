# Gemini 代码自动评审 GitHub Action

一个基于 Google Gemini API 的自动化代码评审 GitHub Action，支持在 PR 新建/更新、核心分支推送时自动触发代码评审，并将评审结果以评论形式提交到 GitHub PR/Commit 中。

## 功能特性
✅ 支持 PR 事件（新建/更新/重开）和核心分支 Push 事件触发  
✅ 调用 Gemini 大模型（默认 `gemini-2.5-flash`）进行代码评审  
✅ 自动将评审结果提交到 GitHub PR/Commit 评论区  
✅ 可自定义模型类型、评论标题、批次大小和重试次数  
✅ 完善的权限配置和错误处理  

## 前置准备
### 1. 获取 Gemini API Key
1. 访问 [Google AI Studio](https://aistudio.google.com/app/apikey)
2. 创建并复制 Gemini API Key
3. 在 GitHub 仓库的 `Settings > Secrets and variables > Actions` 中添加密钥：
   - 名称：`GEMINI_API_KEY`
   - 值：复制的 Gemini API Key

### 2. 环境要求
- GitHub 仓库（公开/私有均可）
- GitHub Actions 功能已启用
- Gemini API Key 有可用调用额度

## 快速使用
### 步骤 1：创建 Workflow 文件
在你的 GitHub 仓库中创建 `.github/workflows/gemini-code-review.yml` 文件，内容如下：

```yaml
name: Gemini 代码自动评审
on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main, master, develop]

permissions:
  pull-requests: write
  contents: write
  statuses: write

jobs:
  code-review:
    runs-on: ubuntu-latest
    steps:
      - name: 检出代码
        uses: actions/checkout@v4

      - name: Gemini 代码自动评审
        uses: ./
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          gemini-model: gemini-2.5-flash
          review-comment-title: 🤖 Gemini 代码评审意见
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### 步骤 2：安装依赖并打包
```bash
npm install
npm run build
```

### 步骤 3：触发评审
- 新建/更新 PR：自动触发评审并在 PR 评论区显示结果
- 推送代码到 main/master/develop 分支：自动触发评审并在最新 Commit 评论区显示结果
- 如果代码评审通过且没有任何问题，评论内容仅输出 `LGTGEMINI`

## 配置参数说明
| 参数名 | 是否必填 | 默认值 | 说明 |
|--------|----------|--------|------|
| `gemini-api-key` | 是 | - | Google Gemini API Key（建议通过 Secrets 传入） |
| `gemini-model` | 否 | `gemini-2.5-flash` | Gemini 模型名称，例如 `gemini-2.5-flash`、`gemini-2.5-pro` |
| `review-comment-title` | 否 | 🤖 Gemini 代码评审意见 | GitHub 评论的标题，支持自定义 |
| `github-token` | 否 | `${{ github.token }}` | GitHub 令牌（默认已配置权限，无需修改） |
| `ignore-comment` | 否 | `IGNORE` | 包含该标记时跳过评审 |
| `ignored-dirs` | 否 | 空 | 额外忽略目录，逗号分隔 |
| `batch-size` | 否 | `10` | 单批评审文件数量，范围 1-10 |
| `max-retries` | 否 | `3` | 请求失败最大重试次数，范围 1-5 |

> 兼容说明：`qianwen-api-key` 和 `qianwen-model` 暂时保留为废弃参数，建议迁移到 `gemini-api-key` / `gemini-model`。

## 发布
发布并覆盖指定 tag，例如 `v2`：

```bash
npm run release -- v2
```

脚本会自动执行：
1. `npm run build`
2. 提交 build 后的本地改动（如有）
3. 删除远端同名 tag（如存在）
4. 删除并重建本地 tag
5. 推送当前分支和新 tag

可通过环境变量自定义 remote 或提交信息：

```bash
REMOTE=origin COMMIT_MESSAGE="Release v2" npm run release -- v2
```

## 核心文件说明
| 文件路径 | 作用 |
|----------|------|
| `action.yml` | 定义 Action 元信息、输入参数、运行环境 |
| `src/main.js` | Action 核心入口，协调代码 Diff 获取、Gemini API 调用、评论提交逻辑 |
| `src/utils.js` | 封装 Gemini API 请求、GitHub API 操作、代码 Diff 获取等工具函数 |
| `dist/index.js` | 打包后的单文件代码（Action 实际运行的文件，通过 ncc 构建） |

## 常见问题
### Q1：出现 403 Resource not accessible by integration 错误？
A：检查 Workflow 中的 `permissions` 配置，确保包含：
```yaml
permissions:
  pull-requests: write
  contents: read
  statuses: write
```

### Q2：Gemini API 调用失败？
A：
1. 确认 API Key 有效且未过期
2. 检查模型名称是否正确
3. 确认 API Key 有足够的调用额度

### Q3：评审结果为空？
A：
1. 检查代码 Diff 是否为空（无代码变更时会跳过评审）
2. Gemini API 响应超时（可在 `src/utils.js` 中调整 timeout 配置）

## 许可证
MIT License

## 致谢
- [Google Gemini](https://ai.google.dev/)：提供大模型 API 支持
- [GitHub Actions](https://docs.github.com/zh/actions)：提供自动化运行环境
- [@actions/core](https://github.com/actions/toolkit/tree/main/packages/core)、[@actions/github](https://github.com/actions/toolkit/tree/main/packages/github)：GitHub Actions 核心工具库
