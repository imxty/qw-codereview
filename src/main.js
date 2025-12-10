const core = require('@actions/core');
const { getQianwenReview, submitReviewToGitHub, getCodeDiff } = require('./utils');

async function run() {
    try {
        // 1. 获取Action输入参数
        const qianwenApiKey = core.getInput('qianwen-api-key', { required: true });
        const qianwenModel = core.getInput('qianwen-model');
        const githubToken = core.getInput('github-token');
        const reviewCommentTitle = core.getInput('review-comment-title');

        // 2. 获取代码Diff
        core.info('正在获取代码Diff...');
        const codeDiff = await getCodeDiff(githubToken);
        if (!codeDiff || codeDiff.length === 0) {
            core.info('未检测到代码Diff，跳过评审');
            return;
        }
        core.info(`获取到Diff长度: ${codeDiff.length} 字符`);

        // 3. 调用千问API进行代码评审
        core.info('正在调用千问API进行代码评审...');
        const reviewContent = await getQianwenReview(codeDiff, qianwenApiKey, qianwenModel);
        core.info('千问评审完成，结果：\n' + reviewContent);

        // 4. 提交评审结果到GitHub
        core.info('正在提交评审结果到GitHub...');
        await submitReviewToGitHub(reviewContent, githubToken, reviewCommentTitle);

        core.info('✅ 代码评审流程完成！');
    } catch (error) {
        core.setFailed(`Action执行失败: ${error.message}`);
    }
}

// 执行主函数
run();