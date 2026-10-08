/**
 * Host half of the workflow studio plugin.
 *
 * The package's main entry exports a Cordis **service class** rather than an
 * `apply` function: Cordis instantiates it, and the class key `workflowStudio`
 * doubles as the Typert namespace the Client mounts against. Dependencies are
 * declared with `static inject` on the class itself.
 *
 * The workflow engine comes from `@deepseek-ai/dsh-workflow-ptc`, which this
 * bundle's patch mounts at the composition root: the engine is a service, not a
 * bundle (its package.json declares no `dsh.bundle`), and profiles otherwise
 * expose it only inside isolated agent-preset groups.
 */

export { WorkflowStudioGateway, WorkflowStudioGateway as default } from './service.js'
