import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, ResearchAssistantBridge } from '../shared.js';

const bridge: ResearchAssistantBridge = {
  getState: () => ipcRenderer.invoke('research-assistant:get-state'),
  signIn: () => ipcRenderer.invoke('research-assistant:sign-in'),
  reconnectSharing: () => ipcRenderer.invoke('research-assistant:reconnect-sharing'),
  cancelSignIn: () => ipcRenderer.invoke('research-assistant:cancel-sign-in'),
  refreshModels: () => ipcRenderer.invoke('research-assistant:refresh-models'),
  verify: (modelSlug) => ipcRenderer.invoke('research-assistant:verify', modelSlug),
  cancelVerification: () => ipcRenderer.invoke('research-assistant:cancel-verification'),
  probeWebSearch: (modelSlug) => ipcRenderer.invoke('research-assistant:probe-web-search', modelSlug),
  cancelWebSearchProbe: () => ipcRenderer.invoke('research-assistant:cancel-web-search-probe'),
  runResearch: (command, modelSlug) =>
    ipcRenderer.invoke('research-assistant:run-research', command, modelSlug),
  cancelResearch: () => ipcRenderer.invoke('research-assistant:cancel-research'),
  exportResearchReport: () => ipcRenderer.invoke('research-assistant:export-research-report'),
  exportEvaluationWorksheet: () =>
    ipcRenderer.invoke('research-assistant:export-evaluation-worksheet'),
  importEvaluationWorksheet: () =>
    ipcRenderer.invoke('research-assistant:import-evaluation-worksheet'),
  exportPortableData: () => ipcRenderer.invoke('research-assistant:export-portable-data'),
  importPortableData: () => ipcRenderer.invoke('research-assistant:import-portable-data'),
  clearPreferences: () => ipcRenderer.invoke('research-assistant:clear-preferences'),
  deletePreference: (key) => ipcRenderer.invoke('research-assistant:delete-preference', key),
  loadReport: (reportId) => ipcRenderer.invoke('research-assistant:load-report', reportId),
  saveMonitoringRule: (rule) => ipcRenderer.invoke('research-assistant:save-monitoring-rule', rule),
  runMonitoringNow: (ruleId) =>
    ipcRenderer.invoke('research-assistant:run-monitoring-now', ruleId),
  setMonitoringItemStatus: (ruleId, sourceId, status) =>
    ipcRenderer.invoke('research-assistant:set-monitoring-item-status', ruleId, sourceId, status),
  setMonitoringItemFeedback: (ruleId, sourceId, feedback) =>
    ipcRenderer.invoke(
      'research-assistant:set-monitoring-item-feedback', ruleId, sourceId, feedback,
    ),
  researchMonitoringItem: (ruleId, sourceId, modelSlug) =>
    ipcRenderer.invoke(
      'research-assistant:research-monitoring-item', ruleId, sourceId, modelSlug,
    ),
  setLaunchAtLogin: (enabled) =>
    ipcRenderer.invoke('research-assistant:set-launch-at-login', enabled),
  openSource: (url) => ipcRenderer.invoke('research-assistant:open-source', url),
  disconnect: () => ipcRenderer.invoke('research-assistant:disconnect'),
  openUsage: () => ipcRenderer.invoke('research-assistant:open-usage'),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on('research-assistant:state', listener);
    return () => ipcRenderer.removeListener('research-assistant:state', listener);
  },
};

contextBridge.exposeInMainWorld('researchAssistant', bridge);
