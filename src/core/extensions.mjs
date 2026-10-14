import { buildSkillPrompt } from './skills.mjs';
import { pluginHandlers } from './plugins.mjs';

export function createExtensionHost({ skillDirs = [], pluginDirs = [], getSettings } = {}) {
  async function settings() {
    if (typeof getSettings !== 'function') return { skills: {}, plugins: {} };
    const value = await getSettings();
    return value && typeof value === 'object' ? value : { skills: {}, plugins: {} };
  }

  return {
    async skillPrompt(role) {
      try {
        const current = await settings();
        const allow = role && Array.isArray(role.skills) ? role.skills : undefined;
        return await buildSkillPrompt(skillDirs, current.skills || {}, allow);
      } catch (err) {
        console.error(`PI_WORK_EXTENSION ${err?.message || err}`);
        return '';
      }
    },
    async pluginTools() {
      try {
        const current = await settings();
        return await pluginHandlers(pluginDirs, current.plugins || {});
      } catch (err) {
        console.error(`PI_WORK_EXTENSION ${err?.message || err}`);
        return [];
      }
    },
  };
}
