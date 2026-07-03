const core = require('@actions/core');
const { getGeminiReview, submitReviewToGitHub, getCodeDiff } = require('./utils');

async function run() {
    try {
        // 获取Action输入参数
        const geminiApiKey = core.getInput('gemini-api-key') || core.getInput('qianwen-api-key');
        if (!geminiApiKey) {
            throw new Error('缺少 Gemini API Key，请配置 gemini-api-key');
        }
        const geminiModel = core.getInput('gemini-model') || core.getInput('qianwen-model');
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

        // 调用 Gemini API 进行代码评审
        core.info('正在调用 Gemini API 进行代码评审...');
        const reviewContent = await getGeminiReview(
            fileDiffs,
            geminiApiKey,
            geminiModel,
            ignoreComment
        );
        core.info('Gemini 评审完成，结果：\n' + reviewContent);

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
