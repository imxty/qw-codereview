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
  core.info(`最终忽略目录列表：${combinedDirs.join(', ')}`);
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

// 过滤diff，仅保留PR修改后的代码（新增行）+ 过滤忽略文件/忽略标记
function filterPRModifiedCode(diffContent, ignoreComment = 'IGNORE') {
  if (!diffContent) return '';

  const diffLines = diffContent.split('\n');
  const filteredLines = [];
  let skipCurrentFile = false;
  let currentFileModifiedLines = [];
  let currentFileName = '';

  for (const line of diffLines) {
    // 匹配文件头，判断是否忽略该文件
    const fileHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileHeaderMatch) {
      // 处理上一个文件的修改行
      if (currentFileModifiedLines.length > 0 && !skipCurrentFile) {
        // 过滤包含忽略标记的文件
        const fileContent = currentFileModifiedLines.join('\n');
        if (!fileContent.includes(ignoreComment)) {
          filteredLines.push(`### 修改文件：${currentFileName}`);
          filteredLines.push(fileContent);
          filteredLines.push('---');
        } else {
          core.info(`文件 ${currentFileName} 包含忽略标记，跳过评审`);
        }
      }

      // 初始化当前文件
      currentFileName = fileHeaderMatch[1] || fileHeaderMatch[2];
      skipCurrentFile = isFileIgnored(currentFileName);
      currentFileModifiedLines = [];
      continue;
    }

    // 跳过忽略文件的所有行
    if (skipCurrentFile) continue;

    // 仅保留新增行（+开头）和上下文行（空格开头），排除删除行（-开头）
    if (line.startsWith('+') || (line.startsWith(' ') && currentFileModifiedLines.length > 0)) {
      // 移除diff行前缀（仅保留纯代码）
      const cleanLine = line.startsWith('+') ? line.substring(1) : line;
      currentFileModifiedLines.push(cleanLine);
    }
  }

  // 处理最后一个文件
  if (currentFileModifiedLines.length > 0 && !skipCurrentFile) {
    const fileContent = currentFileModifiedLines.join('\n');
    if (!fileContent.includes(ignoreComment)) {
      filteredLines.push(`### 修改文件：${currentFileName}`);
      filteredLines.push(fileContent);
    }
  }

  const filteredModifiedCode = filteredLines.join('\n').trim();
  core.info(`PR修改后的代码（已过滤忽略文件）：\n${filteredModifiedCode}`);
  return filteredModifiedCode;
}

// 获取PR的修改代码（仅新增/变更部分）
async function getPRModifiedCode(githubToken) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;
  const ignoreComment = core.getInput('ignore-comment') || 'IGNORE';

  // 仅支持PR事件
  if (!context.payload.pull_request) {
    throw new Error('该脚本仅支持PR事件，请在PR触发的Workflow中使用');
  }

  const pullNumber = context.payload.pull_request.number;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  try {
    core.info(`获取PR #${pullNumber} 的完整Diff...`);
    // 获取PR的完整diff
    const { data: diffData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: 'diff'
      }
    });

    // 过滤仅保留修改后的代码（新增行）
    return filterPRModifiedCode(diffData, ignoreComment);
  } catch (error) {
    if (error.message.includes('too_large') || error.message.includes('maximum number of files')) {
      core.warning('PR文件数量超限，逐个获取文件的修改代码');

      // 分页获取PR变更文件
      const files = [];
      let page = 1;
      while (true) {
        const { data: pageFiles } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
          page
        });
        if (pageFiles.length === 0) break;
        files.push(...pageFiles);
        page++;
      }

      // 仅处理非忽略文件的修改代码
      const modifiedCodeList = [];
      const nonIgnoredFiles = files.filter(file => !isFileIgnored(file.filename));
      core.info(`PR共修改 ${files.length} 个文件，过滤忽略目录后剩余 ${nonIgnoredFiles.length} 个文件`);

      // 限制处理文件数量，避免超限
      const limitedFiles = nonIgnoredFiles.slice(0, 50);
      for (const file of limitedFiles) {
        if (file.patch && !file.patch.includes(ignoreComment)) {
          // 仅提取新增行
          const patchLines = file.patch.split('\n');
          const modifiedLines = patchLines
            .filter(line => line.startsWith('+') || (line.startsWith(' ') && patchLines.some(l => l.startsWith('+'))))
            .map(line => line.startsWith('+') ? line.substring(1) : line);

          if (modifiedLines.length > 0) {
            modifiedCodeList.push(`### 修改文件：${file.filename}`);
            modifiedCodeList.push(modifiedLines.join('\n'));
            modifiedCodeList.push('---');
          }
        }
      }

      return modifiedCodeList.join('\n').trim();
    }
    throw error;
  }
}

// 调用千问API评审PR修改后的代码
async function reviewPRModifiedCode(modifiedCode, apiKey, model = 'qwen-turbo') {
  if (!modifiedCode || modifiedCode.trim() === '') {
    const result = 'PR中无需要评审的修改代码（所有文件均为忽略目录/包含忽略标记），评审通过';
    core.info(result);
    return result;
  }

  // 评审提示词：仅聚焦修改后的代码
  const reviewPrompt = `
    你是资深代码评审专家，请仅评审以下PR中**新增/修改后的代码**，严格遵守以下规则：
    1. 只关注修改后的代码本身，不评审未变更的历史代码
    2. 重点检查：
       - 语法错误、逻辑漏洞、边界条件处理
       - 变量/函数命名规范、代码风格一致性
       - 性能问题、潜在bug、安全风险
       - 注释准确性、代码可读性
    3. 给出具体的修复建议（包含代码示例），指出具体问题位置
    4. 无问题时回复："PR修改代码评审通过，未发现明显问题"
    5. 语言简洁专业，优先使用中文

    PR修改后的代码内容：
    ${modifiedCode}
  `.trim();

  try {
    core.info('调用千问API评审PR修改代码...');
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      {
        model: model,
        input: {
          messages: [
            {
              role: 'user',
              content: reviewPrompt
            }
          ]
        },
        parameters: {
          result_format: 'text',
          temperature: 0.2,
          top_p: 0.8,
          max_tokens: 3000
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

    const reviewResult = response.data.output?.text ? response.data.output.text.trim() : '评审结果获取失败';
    core.info(`PR修改代码评审结果：${reviewResult}`);
    return reviewResult;
  } catch (error) {
    core.error(`千问API调用失败: ${error.message}`);
    throw new Error(`评审PR修改代码失败：${error.message}`);
  }
}

// 设置PR状态（通过/不通过）
async function setPRStatus(githubToken, isPassed, reviewResult) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;

  const pullNumber = context.payload.pull_request.number;
  const sha = context.payload.pull_request.head.sha;
  const state = isPassed ? 'success' : 'failure';
  const description = isPassed ? 'PR修改代码评审通过' : 'PR修改代码存在问题，需优化';

  try {
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state,
      context: 'PR修改代码评审',
      description,
      target_url: context.payload.pull_request.html_url
    });
    core.info(`PR #${pullNumber} 状态已设置为：${state}`);
  } catch (error) {
    core.error(`设置PR状态失败: ${error.message}`);
  }
}

// 提交评审结果到PR评论
async function submitPRReviewComment(reviewResult, githubToken, title = 'PR修改代码评审结果') {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;

  if (!context.payload.pull_request) return;

  const pullNumber = context.payload.pull_request.number;
  await octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pullNumber,
    body: `### ${title}\n\n${reviewResult}`
  });
  core.info(`评审结果已提交到PR #${pullNumber} 的评论区`);
}

// 主函数：评审PR修改后的代码
async function reviewPR() {
  try {
    // 获取输入参数
    const githubToken = core.getInput('github-token', { required: true });
    const qianwenApiKey = core.getInput('qianwen-api-key', { required: true });
    const qianwenModel = core.getInput('qianwen-model') || 'qwen-turbo';

    // 1. 获取PR修改后的代码（仅新增/变更部分）
    const modifiedCode = await getPRModifiedCode(githubToken);

    // 2. 调用千问API评审修改后的代码
    const reviewResult = await reviewPRModifiedCode(modifiedCode, qianwenApiKey, qianwenModel);

    // 3. 判断是否通过评审
    const isPassed = reviewResult.includes('评审通过') && !reviewResult.includes('未发现明显问题');

    // 4. 设置PR状态
    await setPRStatus(githubToken, isPassed, reviewResult);

    // 5. 提交评审结果到PR评论
    await submitPRReviewComment(reviewResult, githubToken);

    // 输出结果
    core.setOutput('review-result', reviewResult);
    core.setOutput('review-passed', isPassed);

    return reviewResult;
  } catch (error) {
    core.setFailed(`评审PR失败：${error.message}`);
    throw error;
  }
}

// 暴露主函数和工具函数
module.exports = {
  reviewPR,
  getPRModifiedCode,
  reviewPRModifiedCode,
  setPRStatus,
  submitPRReviewComment
};

// 直接运行时执行主函数
if (require.main === module) {
  reviewPR();
}