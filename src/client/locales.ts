/** `task-ui` namespace dictionaries: the persistent task panel copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': '任务',
  'panel.empty': '无任务',
  'panel.summary': '进行中 {running} · 已完成 {done} · 已阻塞 {blocked}',
  'panel.job': '任务 {id}',
  'status.pending': '待处理',
  'status.running': '进行中',
  'status.done': '已完成',
  'status.blocked': '已阻塞',
  'status.failed': '失败',
  'action.delete': '删除',
  'action.confirmDelete': '确认删除？',
  'action.split': '拆分',
  'action.collapse': '折叠',
  'error.refresh': '刷新失败：{detail}',
  'error.operation': '操作失败：{detail}',
} satisfies Record<string, string>

/** The `task-ui` namespace key union. */
export type TaskUiKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.title': 'Tasks',
  'panel.empty': 'No tasks',
  'panel.summary': '{running} running · {done} done · {blocked} blocked',
  'panel.job': 'job {id}',
  'status.pending': 'Pending',
  'status.running': 'Running',
  'status.done': 'Done',
  'status.blocked': 'Blocked',
  'status.failed': 'Failed',
  'action.delete': 'Delete',
  'action.confirmDelete': 'Confirm delete?',
  'action.split': 'Split',
  'action.collapse': 'Collapse',
  'error.refresh': 'Refresh failed: {detail}',
  'error.operation': 'Operation failed: {detail}',
} satisfies Record<TaskUiKey, string>
