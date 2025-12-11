const core = require('@actions/core');
const { getQianwenReview, submitReviewToGitHub, getCodeDiff } = require('./utils');

async function run() {
    try {
        // 获取Action输入参数
        const qianwenApiKey = core.getInput('qianwen-api-key', { required: true });
        const qianwenModel = core.getInput('qianwen-model');
        const githubToken = core.getInput('github-token');
        const reviewCommentTitle = core.getInput('review-comment-title');
        const ignoreComment = core.getInput('ignore-comment');

        // 获取代码Diff（按文件分割）
        core.info('正在获取代码Diff...');
        const fileDiffs = await getCodeDiff(githubToken);
        if (!fileDiffs || Object.keys(fileDiffs).length === 0) {
            core.info('未检测到需评审的代码Diff，跳过评审');
            return;
        }
        core.info(`获取到 ${Object.keys(fileDiffs).length} 个文件的Diff`);

        // 调用千问API进行代码评审
        core.info('正在调用千问API进行代码评审...');
        const reviewContent = await getQianwenReview(
            fileDiffs,
            qianwenApiKey,
            qianwenModel,
            ignoreComment
        );
        core.info('千问评审完成，结果：\n' + reviewContent);

        // 提交评审结果到GitHub
        core.info('正在提交评审结果到GitHub...');
        await submitReviewToGitHub(reviewContent, githubToken, reviewCommentTitle);

        core.info('✅ 代码评审流程完成！');
    } catch (error) {
        core.setFailed(`Action执行失败: ${error.message}`);
    }
}

// 执行主函数
run();