const axios = require('axios');
const core = require('@actions/core');
const github = require('@actions/github');

// 基础忽略目录列表（内置通用规则）
const BASE_IGNORED_DIRS = [
  'bin/', 'build/', 'dist/', 'conf/', 'vendor/', 'node_modules/', 'tmp/',
  'logs/', 'cache/', 'coverage/', 'public/', 'assets/', 'static/', 'lib/', 'libs/',
  'target/', 'out/', 'output/', 'temp/', '.git/', '.svn/', '.hg/', '.idea/', '.vscode/',
  'bower_components/', 'jspm_packages/', 'typings/', 'npm-debug.log/', 'yarn-error.log/',
  'pnpm-lock.yaml/', 'package-lock.json/', 'yarn.lock/', 'composer.lock/'
];

// 新增基础忽略文件后缀（内置通用规则）
// 按类型分类的基础忽略后缀（可按需增删）
const BASE_IGNORED_EXTENSIONS = [
  // 图片
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.ico', '.webp', '.tiff',
  // 视频
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.mpeg', '.mpg', '.m4v',
  // 音频（可选补充）
  '.mp3', '.wav', '.flac', '.aac', '.ogg',
  // 文本/文档
  '.txt', '.md', '.doc', '.docx', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.lock',
  // 配置文件
  '.json', '.yml', '.yaml', '.ini', '.conf', '.toml', '.xml', '.properties',
  // 压缩包（可选补充）
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
  // 日志文件（核心新增）
  '.log', '.logs', '.txt.log', '.debug', '.error', '.warn',
  // 临时文件（补充）
  '.tmp', '.temp', '.bak', '.swp', '.swo'
];

// 合并基础忽略后缀 + 自定义忽略后缀
function getCombinedIgnoredExtensions() {
  const customIgnoredExtsStr = core.getInput('ignored-extensions') || '';
  const customIgnoredExts = customIgnoredExtsStr.split(',')
    .map(ext => ext.trim())
    .filter(ext => ext)
    .map(ext => ext.startsWith('.') ? ext : `.${ext}`); // 统一添加前缀点
  return [...new Set([...BASE_IGNORED_EXTENSIONS, ...customIgnoredExts])];
}
// 合并基础忽略目录 + 自定义忽略目录
function getCombinedIgnoredDirs() {
  const customIgnoredDirsStr = core.getInput('ignored-dirs') || '';
  const customIgnoredDirs = customIgnoredDirsStr.split(',')
    .map(dir => dir.trim())
    .filter(dir => dir)
    .map(dir => dir.endsWith('/') ? dir : `${dir}/`);
  return [...new Set([...BASE_IGNORED_DIRS, ...customIgnoredDirs])];
}

function isFileIgnored(filePath) {
  const IGNORED_DIRS = getCombinedIgnoredDirs();
  const IGNORED_EXTS = getCombinedIgnoredExtensions();
  const lowerFilePath = filePath.toLowerCase();

  // 目录忽略判断（原有逻辑）
  const isDirIgnored = IGNORED_DIRS.some(ignoredDir => {
    const lowerIgnoredDir = ignoredDir.toLowerCase();
    return lowerFilePath.startsWith(lowerIgnoredDir) || lowerFilePath === lowerIgnoredDir.replace('/', '');
  });

  // 新增后缀忽略判断
  const isExtIgnored = IGNORED_EXTS.some(ext => {
    return lowerFilePath.endsWith(ext.toLowerCase());
  });

  return isDirIgnored || isExtIgnored;
}

// 解析Diff获取每个文件的修改内容（保留完整diff格式）
function getFileDiffs(diffContent, ignoreComment = 'IGNORE') {
  if (!diffContent) return {};

  const diffLines = diffContent.split('\n');
  const fileDiffs = {};
  let currentFile = null;
  let currentLines = [];
  let skipCurrentFile = false;

  for (const line of diffLines) {
    const fileHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileHeaderMatch) {
      // 处理上一个文件
      if (currentFile && !skipCurrentFile && currentLines.length > 0) {
        const fileDiff = currentLines.join('\n').trim();
        if (!fileDiff.includes(ignoreComment)) {
          fileDiffs[currentFile] = fileDiff;
        }
      }

      // 初始化新文件
      currentFile = fileHeaderMatch[1] || fileHeaderMatch[2];
      const isRemovedFile = fileHeaderMatch[2] === '/dev/null';
      const isRenamedFile = fileHeaderMatch[1] !== fileHeaderMatch[2] &&
        !isRemovedFile &&
        fileHeaderMatch[1] !== '/dev/null';
      skipCurrentFile = isFileIgnored(currentFile) || isRemovedFile || isRenamedFile;
      currentLines = [line];
      continue;
    }

    if (currentFile && !skipCurrentFile) {
      // 保留完整diff格式：+/- 行、上下文行、hunk头、文件元信息
      if (line.startsWith('@@') ||
          line.startsWith('diff --git') ||
          line.startsWith('index ') ||
          line.startsWith('---') ||
          line.startsWith('+++') ||
          line.startsWith('+') ||
          line.startsWith('-') ||
          line.startsWith(' ')) {
        currentLines.push(line);
      }
      // 跳过其他行（如 \ No newline at end of file 等）
    }
  }

  // 处理最后一个文件
  if (currentFile && !skipCurrentFile && currentLines.length > 0) {
    const fileDiff = currentLines.join('\n').trim();
    if (!fileDiff.includes(ignoreComment)) {
      fileDiffs[currentFile] = fileDiff;
    }
  }

  core.info(`解析出 ${Object.keys(fileDiffs).length} 个需评审的文件`);
  return fileDiffs;
}

// 获取所有PR文件（支持分页获取全部文件）
async function getAllPRFiles(octokit, owner, repo, pullNumber) {
  const allFiles = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    core.info(`获取文件列表第 ${page} 页...`);
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page
    });

    if (files.length === 0) break; // 没有更多文件时退出循环
    allFiles.push(...files);
    page++;

    // 避免API请求过于频繁
    if (files.length === perPage) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return allFiles;
}

// 获取代码Diff（按文件分割）
async function getCodeDiff(githubToken) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;
  const ignoreComment = core.getInput('ignore-comment') || 'IGNORE';

  // 强制仅支持PR事件
  if (!context.payload.pull_request) {
    core.error('该脚本仅支持PR事件，请在PR触发的Workflow中使用');
    throw new Error('仅支持PR事件，不支持Push等其他事件');
  }

  const pullNumber = context.payload.pull_request.number;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  // curl -L \
  // -H "Accept: application/vnd.github.v3.diff" \
  // -H "Authorization: token xxxx" \
  // "https://api.github.com/repos/xx/xxxx/pulls/21"
  try {
    core.info('尝试获取PR完整Diff...');
    const { data: diffData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: 'diff' }
    });
    return getFileDiffs(diffData, ignoreComment);
  } catch (error) {
    if (error.message.includes('too_large') || error.message.includes('maximum number of files')) {
      core.warning('PR文件数量超限，将逐个获取非忽略的新增文件的修改代码');

      // 获取所有文件（分页处理）
      const allFiles = await getAllPRFiles(octokit, owner, repo, pullNumber);

      // 仅保留新增文件（status为added）且不在忽略目录中
      const nonIgnoredFiles = allFiles.filter(file =>
        file.status !== 'removed' && file.status !== 'renamed' && !isFileIgnored(file.filename)
      );

      core.info(`PR中共变更 ${allFiles.length} 个文件，过滤后剩余 ${nonIgnoredFiles.length} 个新增文件需处理`);

      const fileDiffs = {};
      for (const file of nonIgnoredFiles) {
        if (file.patch) {
          // 保留完整 patch 格式（包含 +/- 行和上下文行）
          const fileDiff = `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
          if (!fileDiff.includes(ignoreComment)) {
            fileDiffs[file.filename] = fileDiff;
          }
        }
      }

      return fileDiffs;
    }
    throw error;
  }
}

// 分批处理Promise（控制并发）
async function batchPromise(operations, batchSize = 3, maxRetries = 3) {
  const results = [];
  const totalBatches = Math.ceil(operations.length / batchSize);

  for (let i = 0; i < operations.length; i += batchSize) {
    const batchIndex = Math.floor(i / batchSize) + 1;
    const batch = operations.slice(i, i + batchSize);
    core.info(`处理第 ${batchIndex}/${totalBatches} 批，共 ${batch.length} 个文件`);

    const batchResults = await Promise.all(
      batch.map(operation => retryOperation(operation, maxRetries))
    );
    results.push(...batchResults);
  }
  return results;
}

// 失败重试机制（针对429限流）
async function retryOperation(operation, maxRetries, baseDelay = 2000) {
  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        core.error(`达到最大重试次数（${maxRetries}次），操作失败: ${error.message}`);
        return {
          fileName: error.message.includes('文件 ') ? error.message.split('文件 ')[1].split(' ')[0] : '未知文件',
          review: `评审失败（已重试${maxRetries}次）: ${error.message}`
        };
      }

      // 仅对429错误重试
      if (error.response?.status !== 429) {
        core.warning(`非限流错误，不重试: ${error.message}`);
        return {
          fileName: error.message.includes('文件 ') ? error.message.split('文件 ')[1].split(' ')[0] : '未知文件',
          review: `评审失败: ${error.message}`
        };
      }

      // 指数退避策略
      const delay = baseDelay * Math.pow(2, retries - 1);
      core.warning(`请求被限流（429），将在 ${delay}ms 后重试（第${retries}次）`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// 过滤无意义的评审建议
function filterTrivialSuggestions(review) {
  if (review.trim() === 'LGTM' || review.trim() === '该文件修改无明显问题') {
    return 'LGTM';
  }

  const lines = review.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('•')) return true; // 非问题行保留

    // 提取建议中的 "A→B" 或 "A改成B" 格式，检查是否是同一内容
    const arrowMatch = trimmed.match(/["'](\S+)["']?\s*[→>改]\s*["']?(\S+)/);
    if (arrowMatch && arrowMatch[1].toLowerCase() === arrowMatch[2].toLowerCase()) {
      return false; // 过滤 "error→error" 类无意义建议
    }

    // 过滤建议内容和原内容完全相同的行（如 "• xxx: 建议将 xxx 改为 xxx"）
    const changeMatch = trimmed.match(/建议将\s*["']?(\S+?)["']?\s*改为\s*["']?(\S+?)["']?\s*$/);
    if (changeMatch && changeMatch[1].toLowerCase() === changeMatch[2].toLowerCase()) {
      return false;
    }

    return true;
  });

  const result = filtered.join('\n').trim();
  // 如果过滤后没有实质性问题了，返回 LGTM
  const hasIssues = filtered.some(line => line.trim().startsWith('•'));
  return hasIssues ? result : 'LGTM';
}

// 按文件进行AI评审
async function reviewFile(fileName, fileDiff, apiKey, model) {
  // 限制单文件diff大小，避免超出API token限制
  const MAX_DIFF_LENGTH = 15000;
  if (fileDiff.length > MAX_DIFF_LENGTH) {
    core.warning(`文件 ${fileName} diff 过长(${fileDiff.length}字符)，截断至${MAX_DIFF_LENGTH}字符`);
    fileDiff = fileDiff.substring(0, MAX_DIFF_LENGTH) + '\n... (diff已截断)';
  }

  const prompt = `请检查以下代码 diff 中 “+” 标记的新增行，仅找出肉眼可见的确定错误。

【唯一检查项】
1. 关键字拼写错误：如 “funtion”→”function”，”retrun”→”return”，”improt”→”import”
2. 变量名/函数名中明确的英文拼写错误：如 “recieve”→”receive”，”defualt”→”default”
3. 单行内一眼可见的明显代码错误：如 1/0（除零）、true=false（赋值当比较）、连续多余运算符

【判断原则】
- 只报单行内就能100%确定是错误的，不需要看上下文就能判断
- diff 只展示了部分代码，看起来”不完整”是正常的，以下一律不算错误：
  括号不匹配、字符串未闭合、缺少分号/逗号、花括号未闭合、代码行看起来被截断

【绝对禁止】
- 禁止对 “-” 删除行或无前缀上下文行提意见
- 禁止提出”可能”、”建议”、”潜在”、”考虑”、”或许”、”应该”等不确定表述
- 禁止提出代码风格、命名规范、性能、安全、逻辑等意见
- 禁止提出修改前后内容相同的建议（如 error→error）
- 没有确定错误时必须回复 “LGTM”，宁可漏报不可误报

【文件路径】${fileName}
【代码变更】
${fileDiff}

【输出格式】
- 无问题：仅回复 “LGTM”
- 有问题：每条一行，格式为 “• [有问题的代码片段]: 具体问题说明”
- 最多列出5条最关键的问题`.trim();

  try {
    const response = await axios.post(
      // OpenAI 官方接口地址（也可替换为自建代理/兼容服务地址）
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: model, // 如 "gpt-3.5-turbo"、"gpt-4" 等 OpenAI 模型名
        messages: [{ role: 'user', content: prompt }], // 移除阿里云的 input 包裹层
        temperature: 0.2, // 直接平铺参数（OpenAI 无 parameters 嵌套）
        max_tokens: 2048,
        // 移除 result_format（OpenAI 天然返回 message 格式，无需该参数）
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}` // 认证方式保持一致
        },
        timeout: 60000
      }
    );

    // 适配 OpenAI 响应结构，并过滤无意义建议
    const rawReview = response.data.choices?.[0]?.message?.content?.trim() || '评审失败：无返回内容';
    return {
      fileName,
      review: filterTrivialSuggestions(rawReview)
    };
  } catch (error) {
    // 优化错误信息捕获（兼容 OpenAI 错误响应格式）
    const errorMsg = error.response
      ? `状态码 ${error.response.status}，原因：${error.response.data?.error?.message ||
      error.response.data?.message ||
      '未知错误'
      }`
      : error.message;
    throw new Error(`文件 ${fileName} 评审失败: ${errorMsg}`);
  }
}

// 生成全局总结
async function getGlobalSummary(fileReviews, apiKey, model) {
  const summaryPrompt = `
    请基于以下各文件的代码检查结果，生成简洁总结。

    要求：
    1. 如果所有文件都是 "LGTM"，直接回复 "✅ 评审结论：通过"
    2. 如果有语法/拼写问题，仅汇总已提到的问题，禁止新增任何未提及的问题
    3. 语言简洁，每条不超过30字
    4. 格式：先写"评审结论：通过/不通过"，再列出问题（如有）

    各文件结果：
    ${fileReviews.map(r => `【${r.fileName}】\n${r.review}`).join('\n\n')}
  `.trim();

  try {
    const response = await axios.post(
      // 替换为 OpenAI 官方接口（或兼容的代理地址）
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: model, // 对应 OpenAI 模型名（如 gpt-3.5-turbo/gpt-4）
        messages: [{ role: 'user', content: summaryPrompt }], // 移除阿里云 input 嵌套
        temperature: 0.2, // 平铺参数（无 parameters 层级）
        max_tokens: 2048  // 移除 result_format（OpenAI 无需此参数）
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}` // 认证方式保持一致
        },
        timeout: 60000
      }
    );

    // 适配 OpenAI 响应结构（核心修改）
    return response.data.choices?.[0]?.message?.content?.trim() || '生成全局总结失败';
  } catch (error) {
    // 优化错误信息（兼容 OpenAI 错误响应格式）
    const errorMsg = error.response
      ? `Request failed with status code ${error.response.status}，原因：${error.response.data?.error?.message || '未知错误'}`
      : error.message;

    core.error(`全局总结生成失败: ${errorMsg}`);
    return `全局总结生成失败: ${errorMsg}`;
  }
}

// 设置PR状态（通过/不通过）
async function setPRStatus(githubToken, isPassed, summary) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;

  if (!context.payload.pull_request) return;

  const state = isPassed ? 'success' : 'failure';
  const description = isPassed ? '代码评审通过' : '代码评审存在问题，需优化';

  try {
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha: context.payload.pull_request.head.sha,
      state: state,
      context: '千问代码评审',
      description: description,
      target_url: context.payload.pull_request.html_url
    });
    core.info(`PR状态已设置为：${state}（${description}）`);
  } catch (error) {
    core.error(`设置PR状态失败: ${error.message}`);
  }
}

// 调用千问API获取代码评审意见（主函数）
async function getQianwenReview(fileDiffs, apiKey, model = 'qwen-turbo', ignoreComment = 'IGNORE') {
  if (!fileDiffs || Object.keys(fileDiffs).length === 0) {
    const result = '所有变更文件均为忽略目录/包含忽略标记的文件，代码评审通过';
    await setPRStatus(core.getInput('github-token'), true, result);
    return result;
  }

  const fileNames = Object.keys(fileDiffs);
  const totalFiles = fileNames.length;
  core.info(`共需评审 ${totalFiles} 个新增文件，开始分批异步评审...`);

  // 生成评审操作列表
  const reviewOperations = fileNames.map(fileName =>
    () => reviewFile(fileName, fileDiffs[fileName], apiKey, model)
  );

  // 读取用户配置的批次大小和重试次数
  const batchSize = Math.min(Math.max(parseInt(core.getInput('batch-size')) || 3, 1), 10);
  const maxRetries = Math.min(Math.max(parseInt(core.getInput('max-retries')) || 3, 1), 5);
  core.info(`使用参数：每批 ${batchSize} 个文件，最多重试 ${maxRetries} 次`);

  // 分批评审
  const fileReviews = await batchPromise(reviewOperations, batchSize, maxRetries);

  // 生成全局总结
  const globalSummary = await getGlobalSummary(fileReviews, apiKey, model);

  // 判断是否通过并设置PR状态
  const isPassed = globalSummary.includes('评审结论：通过') || globalSummary.includes('LGTM');
  await setPRStatus(core.getInput('github-token'), isPassed, globalSummary);

  // 构建最终结果
  const finalResult = `
## 代码评审结果
### 文件评审明细（共${totalFiles}个文件）：
${fileReviews
      .filter(r => r.review !== 'LGTM') // 过滤无问题的文件
      .map(r => `\n#### ${r.fileName}\n${r.review}`)
      .join('\n') || '所有文件均无明显问题'}

---
### 全局评审总结
${globalSummary}
  `.trim();

  return finalResult;
}

// 提交评审意见到GitHub PR
async function submitReviewToGitHub(reviewContent, githubToken, commentTitle) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;
  const MAX_COMMENT_LENGTH = 65536; // GitHub评论最大长度限制

  const issueNumber = context.payload.pull_request.number;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  // 拆分内容为多个块
  const chunks = [];
  let currentPosition = 0;

  while (currentPosition < reviewContent.length) {
    // 计算当前块的结束位置（预留标题和分隔符的空间）
    const remainingLength = reviewContent.length - currentPosition;
    const chunkLength = Math.min(remainingLength, MAX_COMMENT_LENGTH - 100); // 预留100字符给标题等
    chunks.push(reviewContent.substring(currentPosition, currentPosition + chunkLength));
    currentPosition += chunkLength;
  }

  // 提交第一个块（带完整标题）
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: `### ${commentTitle}\n\n${chunks[0]}`
  });

  // 提交剩余块（带续篇标记）
  for (let i = 1; i < chunks.length; i++) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `### ${commentTitle}（续${i}/${chunks.length - 1}）\n\n${chunks[i]}`
    });
    // 避免API请求过于频繁
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  core.info(`评审意见已分${chunks.length}部分提交到PR #${issueNumber}`);
}

module.exports = {
  getQianwenReview,
  submitReviewToGitHub,
  getCodeDiff
};