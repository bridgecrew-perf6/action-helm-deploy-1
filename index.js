const github = require('@actions/github')
const core = require('@actions/core')
const { execFileSync } = require('child_process');

const ghToken = process.env['INPUT_TOKEN']
const context = github.context;
const gh = github.getOctokit(ghToken)

// core.info(JSON.stringify(context.payload, null, 1))

async function createDeployment() {

    // const transient_environment = process.env['GITHUB_EVENT_NAME'] === 'pull_request'

    deploy_ref = context.sha

    if (process.env['GITHUB_EVENT_NAME'] === 'pull_request') {
        deploy_ref = process.env['GITHUB_HEAD_REF']
    }

    const payload = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        ref: deploy_ref,
        required_contexts: [],
        auto_merge: false,
        environment: process.env['DEPLOY_ENV'],
    }
    core.info(`Creating deployment: ${JSON.stringify(payload)}`)
    try {
        return await gh.repos.createDeployment(payload)
    } catch (ex) {
        throw new Error(`Failed to create deployment: ${ex}`)
    }
}

async function deleteDeployment() {
    const environment = process.env['DEPLOY_ENV']
    core.info(`Deleting deployment environment: ${environment}`)
    try {
        const { data } = await gh.repos.listDeployments({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            environment,
        })

        const deploymentIds = data.map((deployment) => deployment.id)

        await Promise.all(deploymentIds.map(async (id) => {
            await gh.repos.createDeploymentStatus({
                owner: context.payload.repository.owner.login,
                repo: context.payload.repository.name,
                deployment_id: id,
                state: 'inactive',
                mediaType: { "previews": ["flash", "ant-man"] }
            })
        }))

        await Promise.all(deploymentIds.map(async (id) => {
            await gh.repos.deleteDeployment({
                owner: context.payload.repository.owner.login,
                repo: context.payload.repository.name,
                deployment_id: id
            })
        }))
    } catch (ex) {
        throw new Error(`Failed to delete deployment ${environment}: ${ex}`)
    }
}

async function createDeploymentStatus(deployment_id, state) {

    const log_url = `https://github.com/sledilnik/website/runs/${context.runId}`
    const environment_url = process.env['DEPLOY_URL']

    const payload = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        deployment_id,
        state,
        log_url,
        environment_url,
        mediaType: { "previews": ["flash", "ant-man"] }
    }
    core.info(`Setting deployment state: ${JSON.stringify(payload)}`)
    try {
        const status = await gh.repos.createDeploymentStatus(payload)
        // core.info(`Deployment status created: ${JSON.stringify(status)}`)
        return status
    } catch (ex) {
        throw new Error(`Failed to create deployment status: ${ex}`)
    }
}

async function helm(args) {
    try {
        core.info(`running: helm ${args.join(' ')}`)
        execFileSync("helm", args, { 'stdio': [0, 1, 1], env: process.env })
    } catch (ex) {
        core.setFailed(ex)
        throw ex
    }
}

async function deploy() {
    core.info("Starting deploy")

    const namespace = process.env['DEPLOY_NAMESPACE']
    const releaseName = process.env['RELEASE_NAME']
    const chartName = process.env['INPUT_CHARTNAME']
    const chartVersion = process.env['INPUT_CHARTVERSION']
    const chartValues = process.env['CHART_VALUES_FILE']

    var deployment = undefined;
    try {
        deployment = await createDeployment()
        await createDeploymentStatus(deployment.data.id, "in_progress")
    } catch (ex) {
        core.setFailed(`Failed to set deployment state to 'in_progress: ${ex}`)
        throw ex
    }

    try {
        const helmArgs = ['upgrade', releaseName, chartName, '--install', '--atomic', '--namespace', namespace, '--version', chartVersion, '-f', chartValues]

        if (process.env['INGRESS_RULE']) {
            helmArgs.push('--set')
            helmArgs.push(`ingressroute.rule=${process.env['INGRESS_RULE']}`)
        }

        if (process.env['IMAGE_TAG']) {
            helmArgs.push('--set')
            helmArgs.push(`image.tag=${process.env['IMAGE_TAG']}`)
        }

        await helm(helmArgs)
        await createDeploymentStatus(deployment.data.id, "success")
    } catch (ex) {
        try {
            await createDeploymentStatus(deployment.data.id, "failure")
        } catch (ex) {
            core.warning(`Failed to set deployment state to failed: ${ex}`)
        }
        core.setFailed(`Helm install failed: ${ex}`)
        throw ex
    }
}

async function undeploy() {
    const namespace = process.env['DEPLOY_NAMESPACE']
    const releaseName = process.env['RELEASE_NAME']
    core.info("Starting undeploy")
    try {
        await helm(['uninstall', releaseName, '--namespace', namespace])
    } catch (ex) {
        ex = new Error(`Helm uninstall failed: ${ex}`)
        core.setFailed(ex)
        throw ex
    }

    try {
        await deleteDeployment()
    } catch (ex) {
        core.setFailed(`Failed to delete deployment: ${ex}`)
        throw ex
    }

}

async function main() {
    try {
        if (process.env['INPUT_ACTION'] == 'undeploy') {
            await undeploy()
        } else {
            await deploy()
        }
    } catch (ex) {
        core.setFailed(ex)
    }
}

main()
