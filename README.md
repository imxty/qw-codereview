# 千问代码自动评审 GitHub Action

一个基于阿里云通义千问大模型的自动化代码评审 GitHub Action，支持在 PR 新建/更新、核心分支推送时自动触发代码评审，并将评审结果以评论形式提交到 GitHub PR/Commit 中。

## 功能特性
✅ 支持 PR 事件（新建/更新/重开）和核心分支 Push 事件触发  
✅ 调用千问大模型（qwen-turbo/qwen-plus/qwen-max）进行代码评审  
✅ 自动将评审结果提交到 GitHub PR/Commit 评论区  
✅ 可自定义评审提示语、模型类型、评论标题  
✅ 完善的权限配置和错误处理  

## 前置准备
### 1. 获取千问 API Key
1. 访问 [阿里云通义千问控制台](https://dashscope.console.aliyun.com/)（需阿里云账号并完成实名认证）
2. 开通「通义千问」API 服务，创建并复制 API Key
3. 在 GitHub 仓库的 `Settings > Secrets and variables > Actions` 中添加密钥：
   - 名称：`QIANWEN_API_KEY`
   - 值：复制的千问 API Key

### 2. 环境要求
- GitHub 仓库（公开/私有均可）
- GitHub Actions 功能已启用
- 千问 API Key 有可用调用额度（免费额度满足基础使用）

## 快速使用
### 步骤 1：创建 Workflow 文件
在你的 GitHub 仓库中创建 `.github/workflows/qianwen-code-review.yml` 文件，内容如下：

```yaml
name: 千问代码自动评审
on:
  pull_request:
    types: [opened, synchronize, reopened]  # PR新建/更新/重开时触发
  push:
    branches: [main, master, develop]       # 推送到核心分支时触发

# 配置Action所需权限
permissions:
  pull-requests: write  # 允许评论PR
  contents: read        # 允许读取代码Diff
  statuses: write       # 可选：如需更新Commit状态

jobs:
  code-review:
    runs-on: ubuntu-latest
    steps:
      - name: 检出代码
        uses: actions/checkout@v4

      # 使用千问代码评审Action
      - name: 千问代码自动评审
        uses: ./  # 若已发布到Marketplace，替换为：your-username/qianwen-code-review-action@v1
        with:
          qianwen-api-key: ${{ secrets.QIANWEN_API_KEY }}  # 千问API密钥
          qianwen-model: qwen-turbo                        # 可选：qwen-plus/qwen-max
          review-comment-title: 🤖 千问代码评审意见         # 自定义评论标题
          github-token: ${{ secrets.GITHUB_TOKEN }}         # GitHub默认令牌
```

### 步骤 2：部署 Action 核心代码
将以下文件结构复制到你的仓库根目录：

```
your-repo/
├── .github/
│   └── workflows/
│       └── qianwen-code-review.yml  # 上面创建的Workflow文件
├── action.yml                       # Action元配置
├── dist/                            # 打包后的代码（见下文构建步骤）
├── src/
│   ├── main.js                      # 核心逻辑
│   └── utils.js                     # 工具函数
└── package.json                     # 依赖配置
```

### 步骤 3：安装依赖并打包
```bash
# 安装依赖
npm install

# 打包代码（生成dist/index.js）
npm run build
```

### 步骤 4：触发评审
- 新建/更新 PR：自动触发评审并在 PR 评论区显示结果
- 推送代码到 main/master/develop 分支：自动触发评审并在 Commit 评论区显示结果

## 配置参数说明
| 参数名                | 是否必填 | 默认值                | 说明                                                                 |
|-----------------------|----------|-----------------------|----------------------------------------------------------------------|
| `qianwen-api-key`     | 是       | -                     | 阿里云通义千问 API Key（需通过 Secrets 传入）                        |
| `qianwen-model`       | 否       | qwen-turbo            | 千问模型类型：qwen-turbo（轻量）/qwen-plus（进阶）/qwen-max（旗舰）   |
| `review-comment-title`| 否       | 🤖 千问代码评审意见    | GitHub 评论的标题，支持自定义                                        |
| `github-token`        | 否       | ${{ github.token }}   | GitHub 令牌（默认已配置权限，无需修改）                              |

## 核心文件说明
| 文件路径          | 作用                                                                 |
|-------------------|----------------------------------------------------------------------|
| `action.yml`      | 定义 Action 元信息、输入参数、运行环境                               |
| `src/main.js`     | Action 核心入口，协调代码Diff获取、千问API调用、评论提交逻辑          |
| `src/utils.js`    | 封装千问API请求、GitHub API操作、代码Diff获取等工具函数              |
| `dist/index.js`   | 打包后的单文件代码（Action实际运行的文件，通过ncc构建）              |

## 自定义扩展
### 1. 修改评审规则
编辑 `src/utils.js` 中的 `getQianwenReview` 函数，修改 prompt 即可自定义评审规则：
```javascript
const prompt = `
  你是前端代码评审专家，请重点检查：
  1. React/Vue 语法规范
  2. ES6+ 特性使用是否合理
  3. 前端性能优化点
  4. 跨域、XSS 等安全问题
  代码Diff内容：
  ${codeDiff}
`;
```

### 2. 调整触发规则
修改 Workflow 文件中的 `on` 字段，例如仅在 PR 新建时触发：
```yaml
on:
  pull_request:
    types: [opened]
```

### 3. 忽略指定文件/目录
在 `src/utils.js` 的 `getCodeDiff` 函数中添加过滤逻辑：
```javascript
// 过滤node_modules和dist目录
const filteredDiff = codeDiff.split('\n').filter(line => {
  return !line.includes('node_modules/') && !line.includes('dist/');
}).join('\n');
```

## 常见问题
### Q1：出现 403 Resource not accessible by integration 错误？
A：检查 Workflow 中的 `permissions` 配置，确保包含：
```yaml
permissions:
  pull-requests: write
  contents: read
```

### Q2：千问API调用失败？
A：
1. 确认 API Key 有效且未过期
2. 检查模型名称是否正确（如 qwen-turbo 而非 qwen Turbo）
3. 确认 API Key 有足够的调用额度

### Q3：评审结果为空？
A：
1. 检查代码 Diff 是否为空（无代码变更时会跳过评审）
2. 千问 API 响应超时（可在 `utils.js` 中调整 timeout 配置）

### Q4：评论未显示在 PR/Commit 中？
A：
1. 确认 GitHub Token 有 `pull-requests: write` 权限
2. 查看 Action 运行日志，检查是否有提交评论的错误信息

## 许可证
MIT License

## 致谢
- [阿里云通义千问](https://dashscope.aliyun.com/)：提供大模型API支持
- [GitHub Actions](https://docs.github.com/zh/actions)：提供自动化运行环境
- [@actions/core](https://github.com/actions/toolkit/tree/main/packages/core)、[@actions/github](https://github.com/actions/toolkit/tree/main/packages/github)：GitHub Actions 核心工具库

## 版本更新记录
### v1.0.0
- 基础功能：PR/Push 事件触发代码评审
- 支持自定义千问模型、评论标题
- 完善的错误处理和日志输出