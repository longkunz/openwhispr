import type { SkillRef } from "../../types/skills";

export interface AttachedSkill {
  ref: SkillRef;
  displayName: string;
  picked?: boolean;
}

export interface ChatSkills {
  attached: AttachedSkill | null;
  pickOff: boolean;
  removed: string[];
}

export const NO_CHAT_SKILLS: ChatSkills = {
  attached: null,
  pickOff: true,
  removed: [],
};

export function readChatSkills(_conversationId: number): ChatSkills {
  return NO_CHAT_SKILLS;
}

export function writeChatSkills(_conversationId: number, _skills: ChatSkills): void {}

export function forgetChatSkills(_conversationId: number): void {}
