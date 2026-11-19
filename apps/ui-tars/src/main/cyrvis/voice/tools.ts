/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface QwenToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const CYRVIS_VOICE_TOOLS: QwenToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'start_gui_task',
      description:
        'Start a GUI task on the user computer. Only call this when the user explicitly asks to open/close an app, control a browser, search, click, type, save a file, or otherwise operate the desktop. Never call for greetings, thanks, identity questions, or chit-chat.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'A clear, self-contained instruction for the GUI agent, including app name and target.',
          },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_gui_task',
      description:
        'Stop the currently running GUI task. Use when the user says stop, cancel, never mind, or asks to abort.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Optional task id; omit to cancel the active task.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_gui_task',
      description: 'Pause the currently running GUI task.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_gui_task',
      description: 'Resume the paused GUI task.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_gui_status',
      description:
        'Get the current GUI task status, progress, last step, and error. Use when the user asks what is happening or how far the task has gone.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Store a durable user preference, identity fact, or recurring context after the user explicitly asks you to remember it. Never store passwords, API keys, tokens, or other secrets.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'A concise, self-contained fact or preference to retain across sessions.',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_update_plan',
      description:
        'Update the travel-plan basic framework (destination, origin, dates, companions, budget, purpose, transport). Use for trip/flight/hotel planning chat. Ask only missing required fields, then offer a skeleton guide. Do NOT call start_gui_task for planning.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          origin: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          companions: { type: 'string' },
          budget: { type: 'string' },
          purpose: { type: 'string' },
          transport: { type: 'string' },
          user_text: {
            type: 'string',
            description: 'Raw user utterance to help fill slots.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_get_plan',
      description:
        'Get the current travel plan phase, missing slots, and speak hint.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_confirm_skeleton',
      description:
        'After required framework fields are filled, confirm the skeleton. If preference is unknown, this points you to travel_probe_highlights first.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_probe_highlights',
      description:
        'After the basic framework is ready, search the destination+dates and return ONE highlight per major category (food, viral check-in, classic landmark, local experience). Then ask which category the user prefers. Do not list many trivia items.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_set_preference',
      description:
        'Record the user travel preference after probing (food / checkin / landmark / experience). Then ask the short constraint card before expanding details.',
      parameters: {
        type: 'object',
        properties: {
          interest: {
            type: 'string',
            description:
              'food | checkin | landmark | experience, or Chinese like 美食/网红打卡/经典必去/当地体验',
          },
          notes: { type: 'string' },
        },
        required: ['interest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_set_constraints',
      description:
        'Save the short constraint card answers: walking a lot, early starts, waiting in queues. Softly bridge into the next planning section afterward.',
      parameters: {
        type: 'object',
        properties: {
          ok_with_walking: { type: 'boolean' },
          ok_with_early_start: { type: 'boolean' },
          ok_with_queues: { type: 'boolean' },
          notes: { type: 'string' },
          user_text: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_expand_aspect',
      description:
        'Expand one travel aspect with 2-3 concrete options + URLs (any destination). For 门票/预约/订票 AND 住宿/酒店/民宿 set with_search=false and only speak/write booking links—never GUI-book. For 行程 include Day1/Day2 draft. Soft handoff.',
      parameters: {
        type: 'object',
        properties: {
          aspect: {
            type: 'string',
            description:
              'accommodation | daily_itinerary | tickets | budget_booking | emergency, or Chinese labels like 住宿/每日行程.',
          },
          notes: { type: 'string' },
          with_search: {
            type: 'boolean',
            description:
              'If true, run a lightweight web search to enrich the aspect.',
          },
        },
        required: ['aspect'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_search',
      description:
        'Search travel-related info for the current plan (flights, hotels, attractions). Include destination month/festival context when relevant.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          aspect: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_decline_expand',
      description:
        'Softly pause further expansion for now. Keep the skeleton/memos; invite the user to add more later. Optionally followed by travel_finalize_plan.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_finalize_plan',
      description:
        'Write+open a styled desktop HTML travel plan page. After success, only tell the user the page is ready on the desktop—never read the full plan aloud.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
