const axios = require('axios');
const core = require('@actions/core');
const github = require('@actions/github');

// 基础忽略目录列表（内置通用规则）
const BASE_IGNORED_DIRS = [
  // 用户初始指定目录
  'bin/',
  'build/',
  'dist/',
  'generate_db_struct/',
  'conf/',
  'vendor/',
  'node_modules/',
  'tmp/',
  // 通用补充忽略目录
  'logs/',
  'cache/',
  'coverage/',
  'public/',
  'assets/',
  'static/',
  'lib/',
  'libs/',
  'target/',
  'out/',
  'output/',
  'temp/',
  '.git/',
  '.svn/',
  '.hg/',
  '.idea/',
  '.vscode/',
  'bower_components/',
  'jspm_packages/',
  'typings/',
  'npm-debug.log/',
  'yarn-error.log/',
  'pnpm-lock.yaml/',
  'package-lock.json/',
  'yarn.lock/',
  'composer.lock/'
];

// 【核心修改】合并基础忽略目录 + 自定义忽略目录
function getCombinedIgnoredDirs() {
  // 读取Action传入的自定义忽略目录参数
  const customIgnoredDirsStr = core.getInput('ignored-dirs') || '';
  // 解析并格式化自定义目录（去重、补全/、过滤空值）
  const customIgnoredDirs = customIgnoredDirsStr.split(',')
    .map(dir => dir.trim())
    .filter(dir => dir) // 过滤空字符串
    .map(dir => dir.endsWith('/') ? dir : `${dir}/`); // 统一补全/

  // 合并并去重
  const combinedDirs = [...new Set([...BASE_IGNORED_DIRS, ...customIgnoredDirs])];
  core.info(`最终忽略目录列表：${combinedDirs.join(', ')}`);
  return combinedDirs;
}

// 判断文件是否在忽略目录中
function isFileIgnored(filePath) {
  const IGNORED_DIRS = getCombinedIgnoredDirs();
  // 统一转为小写，避免大小写问题
  const lowerFilePath = filePath.toLowerCase();
  return IGNORED_DIRS.some(ignoredDir => {
    const lowerIgnoredDir = ignoredDir.toLowerCase();
    // 匹配目录前缀（如 "dist/file.js" 匹配 "dist/"）
    return lowerFilePath.startsWith(lowerIgnoredDir) ||
      // 匹配根目录下的忽略文件（如 "package-lock.json"）
      lowerFilePath === lowerIgnoredDir.replace('/', '');
  });
}

// 原生解析diff获取受影响文件列表（增加过滤）
function getFilesFromDiff(diff) {
  const files = new Set();
  const lines = diff.split('\n');
  const fileLineRegex = /^(diff --git a\/|--- a\/|\+\+\+ b\/)(.+?)(\s|$)/;

  lines.forEach(line => {
    const match = line.match(fileLineRegex);
    if (match && match[2]) {
      const fileName = match[2].replace(/\/dev\/null/, '');
      if (fileName && !isFileIgnored(fileName)) { // 过滤忽略文件
        files.add(fileName);
      }
    }
  });

  const fileList = Array.from(files);
  core.info(`解析Diff获取到变更文件（已过滤忽略目录）：${fileList.join(', ')}`);
  return fileList;
}

// 获取变更文件的完整内容作为上下文（仅处理非忽略文件）
async function getFileContents(githubToken, diff) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;
  const files = getFilesFromDiff(diff);
  const fileContents = {};

  // 限制最多获取20个文件内容，避免token超限
  const limitedFiles = files.slice(0, 20);
  core.info(`将获取 ${limitedFiles.length} 个非忽略文件的完整内容作为上下文`);

  for (const file of limitedFiles) {
    // 二次校验，防止漏过滤
    if (isFileIgnored(file)) {
      core.debug(`跳过忽略文件的内容获取：${file}`);
      continue;
    }
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: file,
        ref: context.sha || context.payload.pull_request?.head?.sha
      });

      if (data.content) {
        fileContents[file] = Buffer.from(data.content, 'base64').toString('utf8');
      }
    } catch (error) {
      core.warning(`无法获取文件内容 ${file}: ${error.message}`);
    }
  }

  return fileContents;
}

// 获取单个文件的diff内容（过滤忽略文件）
async function getSingleFileDiff(octokit, owner, repo, pullNumber, filePath) {
  // 过滤忽略文件
  if (isFileIgnored(filePath)) {
    core.debug(`跳过忽略文件的Diff获取：${filePath}`);
    return '';
  }
  try {
    const { data } = await octokit.rest.pulls.getFile({
      owner,
      repo,
      pull_number: pullNumber,
      file_path: filePath
    });
    // 构建单个文件的diff格式
    return `diff --git a/${filePath} b/${filePath}\n${data.patch || ''}`;
  } catch (error) {
    core.warning(`无法获取文件 ${filePath} 的diff: ${error.message}`);
    return '';
  }
}

// 过滤Diff内容中的忽略文件
function filterIgnoredFilesFromDiff(diffContent) {
  if (!diffContent) return '';

  const diffLines = diffContent.split('\n');
  const filteredLines = [];
  let skipCurrentFile = false;

  for (const line of diffLines) {
    // 匹配diff的文件头行（diff --git a/xxx b/xxx）
    const fileHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileHeaderMatch) {
      const filePath = fileHeaderMatch[1] || fileHeaderMatch[2];
      skipCurrentFile = isFileIgnored(filePath);
      // 仅保留非忽略文件的头行
      if (!skipCurrentFile) {
        filteredLines.push(line);
      }
      continue;
    }

    // 非文件头行：仅保留非忽略文件的内容
    if (!skipCurrentFile) {
      filteredLines.push(line);
    }
  }

  const filteredDiff = filteredLines.join('\n').trim();
  core.info(`Diff过滤后长度：${filteredDiff.length} 字符`);
  return filteredDiff;
}

// 获取代码Diff（兼容大文件数量PR + 过滤忽略目录）
async function getCodeDiff(githubToken) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;

  // Push事件：原有逻辑（无文件数量限制）
  if (!context.payload.pull_request) {
    core.info('处理Push事件，获取Commit Diff');
    try {
      const { data: diffData } = await octokit.rest.repos.getCommit({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: context.sha,
        mediaType: {
          format: 'diff'
        }
      });
      // 过滤Diff中的忽略文件内容
      return filterIgnoredFilesFromDiff(diffData);
    } catch (error) {
      core.error(`获取Push事件Diff失败：${error.message}`);
      throw error;
    }
  }

  // PR事件：处理大文件数量场景
  const pullNumber = context.payload.pull_request.number;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  try {
    // 先尝试获取完整diff（兼容小文件数量场景）
    core.info('尝试获取PR完整Diff...');
    const { data: diffData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: 'diff'
      }
    });
    // 过滤Diff中的忽略文件内容
    return filterIgnoredFilesFromDiff(diffData);
  } catch (error) {
    // 捕获文件数量超限错误，改用逐个文件获取diff
    if (error.message.includes('too_large') || error.message.includes('maximum number of files')) {
      core.warning('PR文件数量超限，将逐个获取非忽略文件的Diff');

      // 获取PR文件列表
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100 // 每页100个，默认最多1000个
      });

      // 过滤忽略文件
      const nonIgnoredFiles = files.filter(file => !isFileIgnored(file.filename));
      core.info(`PR中共变更 ${files.length} 个文件，过滤后剩余 ${nonIgnoredFiles.length} 个非忽略文件`);

      // 限制最多处理50个文件的diff，避免内容过大
      const limitedFiles = nonIgnoredFiles.slice(0, 50);
      core.info(`将获取前 ${limitedFiles.length} 个非忽略文件的Diff`);

      // 逐个获取文件diff并拼接
      let combinedDiff = '';
      for (const file of limitedFiles) {
        const fileDiff = await getSingleFileDiff(octokit, owner, repo, pullNumber, file.filename);
        if (fileDiff) {
          combinedDiff += fileDiff + '\n\n';
        }
      }

      if (!combinedDiff) {
        core.info('所有变更文件均为忽略目录下的文件，跳过评审');
        return '';
      }
      return combinedDiff;
    }
    // 其他错误直接抛出
    throw error;
  }
}

// 调用千问API获取代码评审意见
async function getQianwenReview(codeDiff, apiKey, model = 'qwen-turbo', fileContents = {}, ignoreComment = 'IGNORE') {
  // 检查是否包含忽略标记
  if (codeDiff.includes(ignoreComment)) {
    return `检测到忽略标记 "${ignoreComment}"，已跳过代码评审`;
  }

  // 空Diff直接返回通过
  if (!codeDiff || codeDiff.trim() === '') {
    return '所有变更文件均为忽略目录下的文件，代码评审通过';
  }

  // 限制diff总长度，避免API Token超限
  const maxDiffLength = 20000;
  const truncatedDiff = codeDiff.length > maxDiffLength
    ? codeDiff.substring(0, maxDiffLength) + '\n...（Diff内容过长已截断）'
    : codeDiff;

  // 构建上下文信息
  let contextInfo = '';
  if (Object.keys(fileContents).length > 0) {
    contextInfo = '相关文件完整内容（用于上下文理解）：\n';
    for (const [file, content] of Object.entries(fileContents)) {
      const truncatedContent = content.length > 3000
        ? content.substring(0, 3000) + '...（内容过长已截断）'
        : content;
      contextInfo += `\n===== ${file} =====\n${truncatedContent}\n`;
    }
  }

  const prompt = `
    你是一位资深的代码评审专家，请严格按照以下规则评审代码：
    1. 重点检查：
       - 拼写错误（变量名、函数名、注释中的文字）
       - 命名规范（一致性、语义化、符合行业惯例）
       - 语法错误和逻辑漏洞
       - 性能问题和潜在风险
    2. 给出具体的修复建议和优化方案，包括修改示例
    3. 语言简洁、专业，优先使用中文
    4. 结合提供的完整文件上下文理解代码意图
    5. 如果代码无问题，回复"代码评审通过，未发现明显问题"
    6. 评审时需要指出具体位置（行号或代码片段）

    ${contextInfo ? contextInfo : '无额外上下文信息'}

    代码Diff内容：
    ${truncatedDiff}
  `;

  try {
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      {
        model: model,
        input: {
          messages: [
            {
              role: 'user',
              content: prompt.trim()
            }
          ]
        },
        parameters: {
          result_format: 'text',
          temperature: 0.2,
          top_p: 0.8,
          max_tokens: 2048
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 60000
      }
    );

    if (response.data.output?.text) {
      return response.data.output.text.trim();
    } else {
      throw new Error('千问API返回无有效内容');
    }
  } catch (error) {
    core.error(`千问API调用失败: ${error.message}`);
    throw new Error(`Qianwen API Error: ${error.message}`);
  }
}

// 提交评审意见到GitHub PR/Commit
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
  } else if (context.sha) {
    await octokit.rest.repos.createCommitComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit_sha: context.sha,
      body: `### ${commentTitle}\n\n${reviewContent}`
    });
    core.info(`评审意见已提交到Commit ${context.sha.substring(0, 7)}`);
  } else {
    throw new Error('不支持的事件类型，仅支持PR和Push事件');
  }
}

module.exports = {
  getQianwenReview,
  submitReviewToGitHub,
  getCodeDiff,
  getFileContents
};