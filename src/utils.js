const axios = require('axios');
const core = require('@actions/core');
const github = require('@actions/github');

// 【修复】原生解析diff获取受影响文件列表（不再依赖diff-parse）
function getFilesFromDiff(diff) {
  const files = new Set();
  const lines = diff.split('\n');

  // 匹配diff中的文件行（格式：diff --git a/xxx b/xxx 或 --- a/xxx / +++ b/xxx）
  const fileLineRegex = /^(diff --git a\/|--- a\/|\+\+\+ b\/)(.+?)(\s|$)/;

  lines.forEach(line => {
    const match = line.match(fileLineRegex);
    if (match && match[2]) {
      const fileName = match[2].replace(/\/dev\/null/, ''); // 过滤空文件标记
      if (fileName) files.add(fileName);
    }
  });

  return Array.from(files);
}

// 获取变更文件的完整内容作为上下文
async function getFileContents(githubToken, diff) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;
  const files = getFilesFromDiff(diff);
  const fileContents = {};

  for (const file of files) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: file,
        ref: context.sha || context.payload.pull_request?.head?.sha
      });

      if (data.content) {
        // 解码base64内容
        fileContents[file] = Buffer.from(data.content, 'base64').toString('utf8');
      }
    } catch (error) {
      core.warning(`无法获取文件内容 ${file}: ${error.message}`);
    }
  }

  return fileContents;
}

// 调用千问API获取代码评审意见
async function getQianwenReview(codeDiff, apiKey, model = 'qwen-turbo', fileContents = {}, ignoreComment = 'IGNORE') {
  // 检查是否包含忽略标记
  if (codeDiff.includes(ignoreComment)) {
    return `检测到忽略标记 "${ignoreComment}"，已跳过代码评审`;
  }

  // 构建上下文信息
  let contextInfo = '';
  if (Object.keys(fileContents).length > 0) {
    contextInfo = '相关文件完整内容（用于上下文理解）：\n';
    for (const [file, content] of Object.entries(fileContents)) {
      // 限制单个文件上下文长度，避免token超限
      const truncatedContent = content.length > 5000 ? content.substring(0, 5000) + '...（内容过长已截断）' : content;
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
    ${codeDiff}
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
          temperature: 0.2, // 降低随机性，提高评审准确性
          top_p: 0.8,
          max_tokens: 2048 // 增加最大token限制
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 60000 // 延长超时时间到60秒
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

  // 兼容PR和Push事件（优先PR评论）
  if (context.payload.pull_request) {
    // PR事件：提交评论到PR
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
      body: `### ${commentTitle}\n\n${reviewContent}`
    });
    core.info(`评审意见已提交到PR #${context.payload.pull_request.number}`);
  } else if (context.sha) {
    // Push事件：提交评论到Commit
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

// 获取代码Diff（PR事件）
async function getCodeDiff(githubToken) {
  const octokit = github.getOctokit(githubToken);
  const context = github.context;

  if (!context.payload.pull_request) {
    // Push事件：获取本次提交的diff
    const { data: diffData } = await octokit.rest.repos.getCommit({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.sha,
      mediaType: {
        format: 'diff'
      }
    });
    return diffData;
  }

  // PR事件：获取完整PR diff
  const { data: diffData } = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    mediaType: {
      format: 'diff'
    }
  });
  return diffData;
}

module.exports = {
  getQianwenReview,
  submitReviewToGitHub,
  getCodeDiff,
  getFileContents
};