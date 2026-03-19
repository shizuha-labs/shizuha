import { ToolRegistry } from '../registry.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { bashTool } from './bash.js';
import { notebookTool } from './notebook.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';
import { askUserTool } from './ask-user.js';
import { taskTool } from './task.js';
import { todoWriteTool, todoReadTool } from './todo.js';
import { enterPlanModeTool, exitPlanModeTool } from './plan-mode.js';
import { taskOutputTool } from './task-output.js';
import { taskStopTool } from './task-stop.js';
import { scheduleJobTool, listJobsTool, removeJobTool, configureHeartbeatTool } from './cron.js';
import { memoryTool } from './memory.js';
import { textToSpeechTool } from './text-to-speech.js';
import { imageGenTool } from './image-gen.js';
import { sessionSearchTool } from './session-search.js';
import { usageStatsTool } from './usage.js';
import { browserTool } from './browser.js';
import { pdfExtractTool } from './pdf-extract.js';
import { updatePlanTool } from './update-plan.js';
import { applyPatchTool } from './apply-patch.js';
import { messageAgentTool, listAgentsTool } from './inter-agent.js';
import { searchSkillsTool, useSkillTool } from './skill-search.js';
import { memoryIndexSearchTool, memoryIndexStatsTool } from './memory-index.js';
import { interactiveReplyTool } from './interactive.js';
import { auditLogTool } from './audit-log.js';
import { pauseAgentTool, resumeAgentTool } from './agent-control.js';

/** Register all built-in tools with a registry */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(notebookTool);
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(askUserTool);
  registry.register(taskTool);
  registry.register(todoWriteTool);
  registry.register(todoReadTool);
  registry.register(enterPlanModeTool);
  registry.register(exitPlanModeTool);
  registry.register(taskOutputTool);
  registry.register(taskStopTool);
  registry.register(scheduleJobTool);
  registry.register(listJobsTool);
  registry.register(removeJobTool);
  registry.register(configureHeartbeatTool);
  registry.register(messageAgentTool);
  registry.register(listAgentsTool);
  registry.register(memoryTool);
  registry.register(textToSpeechTool);
  registry.register(imageGenTool);
  registry.register(sessionSearchTool);
  registry.register(usageStatsTool);
  registry.register(browserTool);
  registry.register(pdfExtractTool);
  registry.register(updatePlanTool);
  registry.register(applyPatchTool);
  registry.register(searchSkillsTool);
  registry.register(useSkillTool);
  registry.register(memoryIndexSearchTool);
  registry.register(memoryIndexStatsTool);
  registry.register(interactiveReplyTool);
  registry.register(auditLogTool);
  registry.register(pauseAgentTool);
  registry.register(resumeAgentTool);
}

export {
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  notebookTool,
  webFetchTool,
  webSearchTool,
  askUserTool,
  taskTool,
  todoWriteTool,
  todoReadTool,
  enterPlanModeTool,
  exitPlanModeTool,
  taskOutputTool,
  taskStopTool,
  scheduleJobTool,
  listJobsTool,
  removeJobTool,
  configureHeartbeatTool,
  messageAgentTool,
  listAgentsTool,
  memoryTool,
  textToSpeechTool,
  imageGenTool,
  sessionSearchTool,
  usageStatsTool,
  browserTool,
  pdfExtractTool,
  updatePlanTool,
  applyPatchTool,
  searchSkillsTool,
  useSkillTool,
  interactiveReplyTool,
  auditLogTool,
  pauseAgentTool,
  resumeAgentTool,
};
