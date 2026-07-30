import { tool } from '@opencode-ai/plugin'
import path from 'node:path'
import { run } from '../../src/internal/operation-controller/controller'
import { FileResource } from '../../src/internal/operation-controller/resources/file-resource'
import type {
  Capability,
  Intent,
  Operation,
  VerificationScope,
} from '../../src/internal/operation-controller/types'

export default tool({
  description: 'Create or modify one file through OperationController',
  args: {
    filePath: tool.schema.string(),
    content: tool.schema.string(),
    operation: tool.schema.enum(['create', 'modify']),
  },
  async execute(args, context) {
    const workspaceRoot =
      typeof context?.worktree === 'string' && context.worktree
        ? context.worktree
        : typeof context?.directory === 'string' && context.directory
          ? context.directory
          : null

    if (!workspaceRoot) {
      throw new Error(
        `Workspace root missing: worktree=${String(context?.worktree)}, directory=${String(context?.directory)}`
      )
    }

    if (!args.filePath || typeof args.filePath !== 'string') {
      throw new Error('filePath is required')
    }

    if (path.isAbsolute(args.filePath)) {
      throw new Error('filePath must be relative to the worktree')
    }

    const operation: Operation = args.operation
    const intent: Intent = {
      id: crypto.randomUUID(),
      requester: 'opencode-operation-controller-write',
      target: args.filePath,
      resourceType: 'file',
      operation,
      effects: [operation],
      changes: 1,
      expectedState: {
        [args.filePath]: args.content,
      },
      observedPaths: [args.filePath],
      verificationScope: 'scoped' as VerificationScope,
    }

    const capabilities: Capability[] = [
      {
        requester: intent.requester,
        resourceType: 'file',
        operation,
        mode: 'granted',
      },
    ]

    const result = run(
      intent,
      capabilities,
      new FileResource(workspaceRoot),
    )

    if (result.status !== 'completed') {
      const reason =
        result.status === 'failed'
          ? `${result.reason} (${result.stage})`
          : result.status === 'denied'
            ? result.reason
            : `Approval required: ${result.mode}`

      throw new Error(reason)
    }

    return { output: `Completed: ${args.filePath}` }
  },
})
