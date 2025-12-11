const axios = require('axios');
const core = require('@actions/core');
const github = require('@actions/github');

// 基础忽略目录列表（内置通用规则）
const BASE_IGNORED_DIRS = [
  'bin/', 'build/', 'dist/', 'generate_db_struct/', 'conf/', 'vendor/', 'node_modules/', 'tmp/',
  'logs/', 'cache/', 'coverage/', 'public/', 'assets/', 'static/', 'lib/', 'libs/', 'target/', 'out/', 'output/', 'temp/',
  '.git/', '.svn/', '.hg/', '.idea/', '.vscode/', 'bower_components/', 'jspm_packages/', 'typings/',
  'npm-debug.log/', 'yarn-error.log/', 'pnpm-lock.yaml/', 'package-lock.json/', 'yarn.lock/', 'composer.lock/'
];

// 合并基础忽略目录 + 自定义忽略目录
function getCombinedIgnoredDirs() {
  const customIgnoredDirsStr = core.getInput('ignored-dirs') || '';
  const customIgnoredDirs = customIgnoredDirsStr.split(',')
    .map(dir => dir.trim())
    .filter(dir => dir)
    .map(dir => dir.endsWith('/') ? dir : `${dir}/`);
  const combinedDirs = [...new Set([...BASE_IGNORED_DIRS, ...customIgnoredDirs])];
  return combinedDirs;
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
      skipCurrentFile = isFileIgnored(currentFile);
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

  core.info(`解析出 ${Object.keys(fileDiffs).length} 个需评审的文件`);
  return fileDiffs;
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
      mediaType: {
        format: 'diff'
      }
    });
    // 按文件分割Diff
    return getFileDiffs(diffData, ignoreComment);
  } catch (error) {
    if (error.message.includes('too_large') || error.message.includes('maximum number of files')) {
      core.warning('PR文件数量超限，将逐个获取非忽略文件的修改代码');

      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100
      });

      const nonIgnoredFiles = files.filter(file => !isFileIgnored(file.filename));
      core.info(`PR中共变更 ${files.length} 个文件，过滤忽略目录后剩余 ${nonIgnoredFiles.length} 个文件`);

      const limitedFiles = nonIgnoredFiles.slice(0, 50);
      core.info(`将处理前 ${limitedFiles.length} 个非忽略目录文件`);

      const fileDiffs = {};
      for (const file of limitedFiles) {
        if (file.patch) {
          // 构建文件Diff
          const patchLines = file.patch.split('\n');
          const modifiedLines = patchLines.filter(line =>
            line.startsWith('+') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
          ).map(line => line.startsWith('+') && !line.startsWith('+++') ? line.substring(1) : line);

          const fileDiff = `diff --git a/${file.filename} b/${file.filename}\n${modifiedLines.join('\n')}`;
          const filteredFileDiff = fileDiff.includes(ignoreComment) ? '' : fileDiff;
          if (filteredFileDiff) {
            fileDiffs[file.filename] = filteredFileDiff;
          }
        }
      }

      return fileDiffs;
    }
    throw error;
  }
}

// 按文件进行AI评审
async function reviewFile(fileName, fileDiff, apiKey, model) {
  const prompt = `
    你是一位资深代码评审专家，请评审以下文件的修改内容：
    1. 仅关注新增/修改的代码（已过滤删除行）
    2. 检查重点：拼写错误、命名规范、语法逻辑、性能风险
    3. 给出具体修复建议和修改示例
    4. 语言简洁专业，优先使用中文
    5. 无问题时回复"该文件修改无明显问题"

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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        timeout: 60000
      }
    );
    return { fileName, review: response.data.output?.text?.trim() || '评审失败' };
  } catch (error) {
    core.error(`文件 ${fileName} 评审失败: ${error.message}`);
    return { fileName, review: `评审失败: ${error.message}` };
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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

  // 仅PR事件设置状态
  if (!context.payload.pull_request) return;

  const state = isPassed ? 'success' : 'failure';
  const description = isPassed ? '代码评审通过' : '代码评审存在问题，需优化';
  const targetUrl = context.payload.pull_request.html_url;

  try {
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha: context.payload.pull_request.head.sha,
      state: state,
      context: '千问代码评审',
      description: description,
      target_url: targetUrl
    });
    core.info(`PR状态已设置为：${state}（${description}）`);
  } catch (error) {
    core.error(`设置PR状态失败: ${error.message}`);
  }
}

// 调用千问API获取代码评审意见（按文件处理）
async function getQianwenReview(fileDiffs, apiKey, model = 'qwen-turbo', ignoreComment = 'IGNORE') {
  if (!fileDiffs || Object.keys(fileDiffs).length === 0) {
    const result = '所有变更文件均为忽略目录/包含忽略标记的文件，代码评审通过';
    await setPRStatus(core.getInput('github-token'), true, result);
    return result;
  }

  const fileNames = Object.keys(fileDiffs);
  core.info(`共需评审 ${fileNames.length} 个文件，开始异步评审...`);

  // 异步评审所有文件
  const reviewPromises = fileNames.map(fileName =>
    reviewFile(fileName, fileDiffs[fileName], apiKey, model)
  );
  const fileReviews = await Promise.all(reviewPromises);

  // 生成全局总结
  const globalSummary = await getGlobalSummary(fileReviews, apiKey, model);

  // 判断是否通过
  const isPassed = globalSummary.includes('评审结论：通过');
  await setPRStatus(core.getInput('github-token'), isPassed, globalSummary);

  // 构建最终结果
  const finalResult = `
## 代码评审完整结果
### 文件评审明细（共${fileNames.length}个文件）：
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