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

// 合并基础忽略目录 + 自定义忽略目录（保留原方法名）
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

// 判断文件是否在忽略目录中（保留原方法名）
function isFileIgnored(filePath) {
  const IGNORED_DIRS = getCombinedIgnoredDirs();
  const lowerFilePath = filePath.toLowerCase();
  return IGNORED_DIRS.some(ignoredDir => {
    const lowerIgnoredDir = ignoredDir.toLowerCase();
    return lowerFilePath.startsWith(lowerIgnoredDir) || lowerFilePath === lowerIgnoredDir.replace('/', '');
  });
}

// 过滤完整Diff内容（仅保留PR修改后的代码 + 过滤忽略目录/忽略标记）
function filterIgnoredFilesFromDiff(diffContent, ignoreComment = 'IGNORE') {
  if (!diffContent) return '';

  const diffLines = diffContent.split('\n');
  const filteredLines = [];
  let skipCurrentFile = false;
  let currentFileDiff = [];
  let currentFileName = '';

  for (const line of diffLines) {
    const fileHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileHeaderMatch) {
      // 处理上一个文件的修改行
      if (currentFileDiff.length > 0 && !skipCurrentFile) {
        const prevFileDiff = currentFileDiff.join('\n');
        // 过滤包含忽略标记的文件
        const filteredPrevFileDiff = prevFileDiff.includes(ignoreComment) ? '' : prevFileDiff;
        if (filteredPrevFileDiff) {
          filteredLines.push(filteredPrevFileDiff);
        }
      }

      // 初始化当前文件
      currentFileName = fileHeaderMatch[1] || fileHeaderMatch[2];
      skipCurrentFile = isFileIgnored(currentFileName);
      currentFileDiff = [line]; // 保留文件头
      continue;
    }

    if (currentFileDiff.length > 0 && !skipCurrentFile) {
      // 仅保留新增行（+开头）和文件头，排除删除行（-开头）
      if (line.startsWith('+') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        // 清理新增行前缀（仅保留纯代码）
        const cleanLine = line.startsWith('+') && !line.startsWith('+++') ? line.substring(1) : line;
        currentFileDiff.push(cleanLine);
      }
    }
  }

  // 处理最后一个文件
  if (currentFileDiff.length > 0 && !skipCurrentFile) {
    const lastFileDiff = currentFileDiff.join('\n');
    const filteredLastFileDiff = lastFileDiff.includes(ignoreComment) ? '' : lastFileDiff;
    if (filteredLastFileDiff) {
      filteredLines.push(filteredLastFileDiff);
    }
  }

  const filteredDiff = filteredLines.join('\n').trim();
  core.info(`Diff过滤后（仅保留PR修改代码）长度：${filteredDiff.length} 字符`);
  return filteredDiff;
}

// 原生解析diff获取受影响文件列表（仅PR修改文件）
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
  core.info(`解析Diff获取到PR变更文件（已过滤忽略目录）：${fileList.join(', ')}`);
  return fileList;
}

// 保留原方法名，但仅返回空对象（因为只评审修改后的代码，无需完整文件内容）
async function getFileContents(githubToken, diff) {
  core.info('仅评审PR修改后的代码，无需获取完整文件内容');
  return {};
}

// 获取代码Diff（仅PR场景 + 仅保留修改后的代码）
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
    core.info('尝试获取PR完整Diff（仅保留修改后的代码）...');
    const { data: diffData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: 'diff'
      }
    });
    // 过滤仅保留PR修改后的代码
    return filterIgnoredFilesFromDiff(diffData, ignoreComment);
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
      core.info(`将处理前 ${limitedFiles.length} 个非忽略目录文件（仅保留修改代码）`);

      let combinedDiff = '';
      for (const file of limitedFiles) {
        if (file.patch) {
          // 仅保留新增行
          const patchLines = file.patch.split('\n');
          const modifiedLines = patchLines.filter(line =>
            line.startsWith('+') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
          ).map(line => line.startsWith('+') && !line.startsWith('+++') ? line.substring(1) : line);

          const fileDiff = `diff --git a/${file.filename} b/${file.filename}\n${modifiedLines.join('\n')}`;
          const filteredFileDiff = fileDiff.includes(ignoreComment) ? '' : fileDiff;
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

// 调用千问API获取分片评审结果（仅评审PR修改后的代码）
async function getChunkReview(chunk, chunkIndex, totalChunks, fileContents, apiKey, model) {
  const chunkPrompt = `
    你是一位资深的代码评审专家，请严格按照以下规则评审PR修改后的代码：
    1. 仅关注本次PR中**新增/修改的代码**（已过滤删除行），不评审未变更的历史代码
    2. 重点检查：
       - 拼写错误（变量名、函数名、注释中的文字）
       - 命名规范（一致性、语义化、符合行业惯例）
       - 语法错误和逻辑漏洞
       - 性能问题和潜在风险
    3. 给出具体的修复建议和优化方案，包括修改示例
    4. 语言简洁、专业，优先使用中文
    5. 如果代码无问题，回复"该分片代码评审通过，未发现明显问题"
    6. 评审时需要指出具体位置（行号或代码片段）

    【当前评审分片 ${chunkIndex + 1}/${totalChunks}】
    PR修改后的代码内容：
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

// 调用千问API生成全局总结（仅基于PR修改代码）
async function getGlobalSummary(reviewChunks, apiKey, model) {
  const summaryPrompt = `
    你是一位资深的代码评审专家，请基于以下多个分片的PR修改代码评审结果，生成一份**全局、简洁、重点突出**的评审总结：
    仅评审本次PR中的**新增/修改代码**，不要评审文件中未变更的内容；
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

// 设置PR状态（通过/不通过）（保留原方法名）
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

// 调用千问API获取代码评审意见（保留原方法名，仅评审PR修改代码）
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

  core.info(`PR修改代码总长度 ${codeDiff.length} 字符，拆分为 ${diffChunks.length} 片，每片最大 ${chunkSize} 字符`);

  // 分片调用AI评审（仅评审修改后的代码）
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

  // 判断是否通过评审
  const isPassed = globalSummary.includes('评审结论：通过');

  // 设置PR状态
  await setPRStatus(core.getInput('github-token'), isPassed, globalSummary);

  // 最终返回结果
  const finalResult = `
## 代码评审完整结果（仅PR修改代码）
### 评审明细（共${diffChunks.length}段）：
${reviewChunks.map((chunk, idx) => `\n#### 代码片段 ${idx + 1}\n${chunk}`).join('\n')}

---
### 全局评审总结
${globalSummary}
    `.trim();

  return finalResult;
}

// 提交评审意见到GitHub PR/Commit（保留原方法名）
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
    core.warning('仅支持PR事件，Push事件不提交评论');
  } else {
    throw new Error('不支持的事件类型，仅支持PR事件');
  }
}

// 保留原导出结构，保证其他JS调用无影响
module.exports = {
  getQianwenReview,
  submitReviewToGitHub,
  getCodeDiff,
  getFileContents
};