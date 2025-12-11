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

// 合并基础忽略目录 + 自定义忽略目录
function getCombinedIgnoredDirs() {
  const customIgnoredDirsStr = core.getInput('ignored-dirs') || '';
  const customIgnoredDirs = customIgnoredDirsStr.split(',')
    .map(dir => dir.trim())
    .filter(dir => dir)
    .map(dir => dir.endsWith('/') ? dir : `${dir}/`);
  return [...new Set([...BASE_IGNORED_DIRS, ...customIgnoredDirs])];
}

// 判断文件是否在忽略目录中
function isFileIgnored(filePath) {
  const IGNORED_DIRS = getCombinedIgnoredDirs();
  const lowerFilePath = filePath.toLowerCase();
  return IGNORED_DIRS.some(ignoredDir => {
    const lowerIgnoredDir = ignoredDir.toLowerCase();
    return lowerFilePath.startsWith(lowerIgnoredDir) || lowerFilePath === lowerIgnoredDir.replace('/', '');
  });
}

// 解析Diff获取每个文件的修改内容（仅保留新增行）
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
      // 检查是否为新增文件（a/路径为/dev/null表示新增）
      const isAddedFile = fileHeaderMatch[1] === '/dev/null';
      skipCurrentFile = isFileIgnored(currentFile) || !isAddedFile;
      currentLines = [line];
      continue;
    }

    if (currentFile && !skipCurrentFile) {
      // 仅保留新增行和文件元信息
      if (line.startsWith('+') || line.startsWith('diff --git') ||
        line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        const cleanLine = line.startsWith('+') && !line.startsWith('+++') ? line.substring(1) : line;
        currentLines.push(cleanLine);
      }
    }
  }

  // 处理最后一个文件
  if (currentFile && !skipCurrentFile && currentLines.length > 0) {
    const fileDiff = currentLines.join('\n').trim();
    if (!fileDiff.includes(ignoreComment)) {
      fileDiffs[currentFile] = fileDiff;
    }
  }

  core.info(`解析出 ${Object.keys(fileDiffs).length} 个需评审的新增文件`);
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
          const patchLines = file.patch.split('\n');
          const modifiedLines = patchLines.filter(line =>
            line.startsWith('+') || line.startsWith('diff --git') ||
            line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
          ).map(line => line.startsWith('+') && !line.startsWith('+++') ? line.substring(1) : line);

          const fileDiff = `diff --git a/${file.filename} b/${file.filename}\n${modifiedLines.join('\n')}`;
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

// 按文件进行AI评审
async function reviewFile(fileName, fileDiff, apiKey, model) {
  const prompt = `
    你是一位严格执行指令的代码评审专家，必须100%遵循以下规则：
    1. 仅处理新增/修改的代码片段，不扩展到其他内容。
    2. 【唯一检查目标】：
      - 纯拼写错误：变量名、函数名、注释中存在的字母拼写错误（如把"data"写成"datatype"这种明确的拼写失误）。
      - 命名可读性问题：名称完全无法理解（如用"a123"代表用户信息这种极端情况）。
    3. 【绝对禁止检查/输出任何以下内容】：
      - 所有语法相关：括号缺失、标签未闭合、变量未定义、函数未声明等。
      - 所有引用相关：变量未使用、导入未使用、常量未引用等。
      - 所有逻辑相关：条件判断、循环逻辑、函数实现等。
      - 所有格式相关：缩进、换行、空格等。
    4. 输出铁律：
      - 只输出符合第2点的问题，一定要100%确定有问题再提出，其他任何内容（包括“可能有问题”的猜测）都绝对不能出现。
      - 每条问题用"•"开头，中文表述，不超过20字。
      - 无符合条件的问题时，仅回复“该文件修改无明显问题”。

    【文件路径】${fileName}
    【修改内容】
    ${fileDiff}
  `.trim();

  try {
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      {
        model: model,
        input: { messages: [{ role: 'user', content: prompt }] },
        parameters: { result_format: 'text', temperature: 0.2, max_tokens: 2048 }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 60000
      }
    );
    return {
      fileName,
      review: response.data.output?.text?.trim() || '评审失败：无返回内容'
    };
  } catch (error) {
    const errorMsg = error.response
      ? `状态码 ${error.response.status}，原因：${error.response.data?.message || '未知错误'}`
      : error.message;
    throw new Error(`文件 ${fileName} 评审失败: ${errorMsg}`);
  }
}

// 生成全局总结
async function getGlobalSummary(fileReviews, apiKey, model) {
  const summaryPrompt = `
    你是一位资深代码评审专家，请基于以下各文件的评审结果，生成一份全局总结：
    1. 汇总所有文件的问题（去重、合并同类问题）
    2. 给出整体的修复建议和优化方向
    3. 明确判断是否"通过评审"（仅当所有文件均无问题时才判定为通过）
    4. 语言简洁、专业，优先使用中文
    5. 格式要求：先写"评审结论"（通过/不通过），再写"核心问题汇总"，最后写"整体优化建议"

    各文件评审结果：
    ${fileReviews.map(r => `【${r.fileName}】\n${r.review}`).join('\n\n')}
  `.trim();

  try {
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      {
        model: model,
        input: { messages: [{ role: 'user', content: summaryPrompt }] },
        parameters: { result_format: 'text', temperature: 0.2, max_tokens: 2048 }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 60000
      }
    );
    return response.data.output?.text?.trim() || '生成全局总结失败';
  } catch (error) {
    core.error(`全局总结生成失败: ${error.message}`);
    return `全局总结生成失败: ${error.message}`;
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
  const isPassed = globalSummary.includes('评审结论：通过');
  await setPRStatus(core.getInput('github-token'), isPassed, globalSummary);

  // 构建最终结果
  const finalResult = `
## 代码评审完整结果
### 文件评审明细（共${totalFiles}个新增文件）：
${fileReviews.map(r => `\n#### ${r.fileName}\n${r.review}`).join('\n')}

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

  if (context.payload.pull_request) {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
      body: `### ${commentTitle}\n\n${reviewContent}`
    });
    core.info(`评审意见已提交到PR #${context.payload.pull_request.number}`);
  } else {
    throw new Error('不支持的事件类型，仅支持PR事件');
  }
}

module.exports = {
  getQianwenReview,
  submitReviewToGitHub,
  getCodeDiff
};