const axios = require('axios');
const core = require('@actions/core');
const github = require('@actions/github');

// 调用千问API获取代码评审意见
async function getQianwenReview(codeDiff, apiKey, model = 'qwen-turbo') {
  const prompt = `
    你是一位资深的代码评审专家，请严格按照以下规则评审代码：
    1. 指出代码中的错误、漏洞、性能问题、不规范写法；
    2. 给出具体的修复建议和优化方案；
    3. 语言简洁、专业，优先使用中文；
    4. 仅评审diff中的代码，不扩展到其他内容；
    5. 如果代码无问题，回复"代码评审通过，未发现明显问题"。

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
          temperature: 0.3, // 低随机性，保证评审严谨
          top_p: 0.8
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 30000 // 30秒超时
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
    // Push事件：获取本次提交的diff（简化版，仅获取当前提交）
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
  getCodeDiff
};