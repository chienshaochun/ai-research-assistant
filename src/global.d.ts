import type { ResearchAssistantBridge } from '../shared';

declare global {
  interface Window {
    researchAssistant: ResearchAssistantBridge;
  }
}

export {};
