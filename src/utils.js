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
  // core.info(`最终忽略目录列表：${combinedDirs.join(', ')}`);
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

// 过滤单个文件Diff中的忽略标记（仅跳过该文件）
function filterFileDiffWithIgnoreComment(fileDiff, ignoreComment) {
  if (fileDiff.includes(ignoreComment)) {
    core.info(`检测到文件Diff包含忽略标记 "${ignoreComment}"，跳过该文件评审`);
    return '';
  }
  return fileDiff;
}

// 过滤完整Diff内容（同时过滤忽略目录 + 忽略标记文件）
function filterIgnoredFilesFromDiff(diffContent, ignoreComment = 'IGNORE') {
  if (!diffContent) return '';

  const diffLines = diffContent.split('\n');
  const filteredLines = [];
  let skipCurrentFile = false;
  let currentFileDiff = [];

  for (const line of diffLines) {
    const fileHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileHeaderMatch) {
      if (currentFileDiff.length > 0) {
        const prevFileDiff = currentFileDiff.join('\n');
        if (!skipCurrentFile) {
          const filteredPrevFileDiff = filterFileDiffWithIgnoreComment(prevFileDiff, ignoreComment);
          if (filteredPrevFileDiff) {
            filteredLines.push(filteredPrevFileDiff);
          }
        }
        currentFileDiff = [];
      }

      const filePath = fileHeaderMatch[1] || fileHeaderMatch[2];
      skipCurrentFile = isFileIgnored(filePath);
      currentFileDiff.push(line);
      continue;
    }

    if (currentFileDiff.length > 0) {
      currentFileDiff.push(line);
    }
  }

  if (currentFileDiff.length > 0) {
    const lastFileDiff = currentFileDiff.join('\n');
    if (!skipCurrentFile) {
      const filteredLastFileDiff = filterFileDiffWithIgnoreComment(lastFileDiff, ignoreComment);
      if (filteredLastFileDiff) {
        filteredLines.push(filteredLastFileDiff);
      }
    }
  }

  const filteredDiff = filteredLines.join('\n').trim();
  core.info(`Diff过滤后长度：${filteredDiff.length} 字符`);
  return filteredDiff;
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
      if (fileName && !isFileIgnored(fileName)) {
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

  const limitedFiles = files.slice(0, 20);
  core.info(`将获取 ${limitedFiles.length} 个非忽略文件的完整内容作为上下文`);

  let targetRef = context.sha;
  if (context.payload.pull_request) {
    targetRef = context.payload.pull_request.head.sha;
    core.info(`PR事件，使用PR头部分支SHA: ${targetRef} 来获取文件内容`);
  }

  for (const file of limitedFiles) {
    if (isFileIgnored(file)) {
      core.debug(`跳过忽略文件的内容获取：${file}`);
      continue;
    }
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: file,
        ref: targetRef
      });

      if (data.content) {
        fileContents[file] = Buffer.from(data.content, 'base64').toString('utf8');
      }
    } catch (error) {
      core.warning(`无法获取文件 ${file} 内容（新增文件/分支不存在）：${error.message}`);
    }
  }

  return fileContents;
}

// 获取代码Diff（兼容大文件数量PR + 过滤忽略目录/忽略标记）
async function getCodeDiff(githubToken) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;
  const ignoreComment = core.getInput('ignore-comment') || 'IGNORE';

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
      return filterIgnoredFilesFromDiff(diffData, ignoreComment);
    } catch (error) {
      core.error(`获取Push事件Diff失败：${error.message}`);
      throw error;
    }
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
    return filterIgnoredFilesFromDiff(diffData, ignoreComment);
  } catch (error) {
    if (error.message.includes('too_large') || error.message.includes('maximum number of files')) {
      core.warning('PR文件数量超限，将逐个获取非忽略文件的Diff');

      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100
      });

      const nonIgnoredFiles = files.filter(file => !isFileIgnored(file.filename));
      core.info(`PR中共变更 ${files.length} 个文件，过滤忽略目录后剩余 ${nonIgnoredFiles.length} 个文件`);

      const limitedFiles = nonIgnoredFiles.slice(0, 50);
      core.info(`将处理前 ${limitedFiles.length} 个非忽略目录文件（含忽略标记过滤）`);

      let combinedDiff = '';
      for (const file of limitedFiles) {
        if (file.patch) {
          const fileDiff = `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
          const filteredFileDiff = filterFileDiffWithIgnoreComment(fileDiff, ignoreComment);
          if (filteredFileDiff) {
            combinedDiff += filteredFileDiff + '\n\n';
          }
        }
      }

      if (!combinedDiff) {
        core.info('所有变更文件均为忽略目录/包含忽略标记的文件，跳过评审');
        return '';
      }
      return combinedDiff;
    }
    throw error;
  }
}

// 调用千问API获取分片评审结果
async function getChunkReview(chunk, chunkIndex, totalChunks, fileContents, apiKey, model) {
  const chunkPrompt = `
    你是一位资深的代码评审专家，请严格按照以下规则评审代码：
    1. 重点检查：
       - 拼写错误（变量名、函数名、注释中的文字）
       - 命名规范（一致性、语义化、符合行业惯例）
       - 语法错误和逻辑漏洞
       - 性能问题和潜在风险
    2. 给出具体的修复建议和优化方案，包括修改示例
    3. 语言简洁、专业，优先使用中文
    4. 结合提供的完整文件上下文理解代码意图
    5. 如果代码无问题，回复"该分片代码评审通过，未发现明显问题"
    6. 评审时需要指出具体位置（行号或代码片段）

    ${Object.keys(fileContents).length > 0 ? `相关文件完整内容：\n${JSON.stringify(fileContents, null, 2)}` : '无额外上下文信息'}

    【当前评审分片 ${chunkIndex + 1}/${totalChunks}】
    代码Diff内容：
    ${chunk}
    ${chunkIndex < totalChunks - 1 ? '\n注意：这是长Diff的其中一个分片，请仅评审当前分片内容，无需关联其他分片' : ''}
    `.trim();

  try {
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      {
        model: model,
        input: {
          messages: [
            {
              role: 'user',
              content: chunkPrompt
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

    return response.data.output?.text ? response.data.output.text.trim() : '获取评审意见失败';
  } catch (error) {
    core.error(`千问API分片 ${chunkIndex + 1} 调用失败: ${error.message}`);
    return `调用失败：${error.message}`;
  }
}

// 调用千问API生成全局总结
async function getGlobalSummary(reviewChunks, apiKey, model) {
  const summaryPrompt = `
    你是一位资深的代码评审专家，请基于以下多个分片的代码评审结果，生成一份**全局、简洁、重点突出**的评审总结：
    1. 汇总所有分片的问题（去重、合并同类问题）
    2. 给出整体的修复建议和优化方向
    3. 明确判断代码是否"通过评审"（仅当所有分片均无问题时才判定为通过）
    4. 语言简洁、专业，优先使用中文
    5. 格式要求：先写"评审结论"（通过/不通过），再写"核心问题汇总"，最后写"整体优化建议"

    分片评审结果列表：
    ${reviewChunks.map((chunk, idx) => `### 分片 ${idx + 1} 评审结果\n${chunk}`).join('\n\n')}
    `.trim();

  try {
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      {
        model: model,
        input: {
          messages: [
            {
              role: 'user',
              content: summaryPrompt
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

    return response.data.output?.text ? response.data.output.text.trim() : '生成全局总结失败';
  } catch (error) {
    core.error(`千问API全局总结调用失败: ${error.message}`);
    return `全局总结生成失败：${error.message}`;
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

// 调用千问API获取代码评审意见（支持长Diff分片 + AI全局总结 + PR状态设置）
async function getQianwenReview(codeDiff, apiKey, model = 'qwen-turbo', fileContents = {}, ignoreComment = 'IGNORE') {
  if (!codeDiff || codeDiff.trim() === '') {
    const result = '所有变更文件均为忽略目录/包含忽略标记的文件，代码评审通过';
    await setPRStatus(core.getInput('github-token'), true, result);
    return result;
  }

  // 分片配置
  const chunkSize = 20000;
  const diffChunks = [];
  for (let i = 0; i < codeDiff.length; i += chunkSize) {
    diffChunks.push(codeDiff.substring(i, i + chunkSize));
  }

  core.info(`Diff总长度 ${codeDiff.length} 字符，拆分为 ${diffChunks.length} 片，每片最大 ${chunkSize} 字符`);

  // 分片调用AI评审
  const reviewChunks = [];
  for (let i = 0; i < diffChunks.length; i++) {
    const chunkReview = await getChunkReview(diffChunks[i], i, diffChunks.length, fileContents, apiKey, model);
    reviewChunks.push(chunkReview);

    // 分片间隔避免限流
    if (i < diffChunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // AI生成全局总结
  const globalSummary = await getGlobalSummary(reviewChunks, apiKey, model);
  core.info(`全局评审总结：${globalSummary}`);

  // 判断是否通过评审（全局总结中包含"评审结论：通过"才判定为通过）
  const isPassed = globalSummary.includes('评审结论：通过');

  // 设置PR状态（核心：有问题则置为failure，PR无法合并）
  await setPRStatus(core.getInput('github-token'), isPassed, globalSummary);

  // 最终返回结果（分片结果 + 全局总结）
  const finalResult = `
## 代码评审完整结果
### 评审明细（共${diffChunks.length}段）：
${reviewChunks.map((chunk, idx) => `\n#### 代码片段 ${idx + 1}\n${chunk}`).join('\n')}

---
### 全局评审总结
${globalSummary}
    `.trim();

  return finalResult;
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