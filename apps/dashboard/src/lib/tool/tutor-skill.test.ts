import { describe, expect, it } from 'vitest';
import {
  applyLearnerPatch,
  applyModuleResearch,
  buildHTurnInstruction,
  buildModuleResearchInstruction,
  buildSkillResearchInstruction,
  buildTutorSystemPrompt,
  legacySkill,
  moduleToPrepare,
  parseSkillItems,
  parseSkillResearch,
  parseTutorTurn,
  renderSkillMarkdown,
  skillItems,
  tutorSkillProjectDescription
} from './tutor-skill';
import { isTutorProject, type TutorProfile } from './tutors';

const profile: TutorProfile = {
  learnerName: 'Lina',
  age: '10',
  subject: 'French basics',
  level: 'Complete beginner',
  learningStyle: 'Short games',
  tone: 'Warm and encouraging',
  language: 'English'
};

const answer = `\`\`\`json
{"tutorName":"Madame Lune","welcome":"Hi Lina! Let's play with French.","approach":"Games first.",
"tips":["Use songs","Repeat often"],
"modules":[{"title":"Greetings","lessons":["Hello and goodbye","How are you?","My name is"]},
{"title":"Numbers","lessons":["1 to 5","6 to 10","Counting games"]},
{"title":"Colours","lessons":["Rainbow words","Colour hunt"]}],
"firstModule":[{"title":"Hello and goodbye","objective":"Say bonjour and au revoir.","activity":"Wave game.","check":"How do you say goodbye?"},
{"title":"How are you?","objective":"Ask ça va.","activity":"Emoji cards.","check":"Answer ça va?"},
{"title":"My name is","objective":"Je m'appelle.","activity":"Name ball.","check":"Introduce yourself."}],
"sources":["BBC Bitesize - https://www.bbc.co.uk/bitesize"]}
\`\`\``;

describe('tutor skill', () => {
  it('asks H for a whole roadmap within the 2,000-character limit', () => {
    const instruction = buildSkillResearchInstruction(profile);
    expect(instruction).toContain('4 to 6 modules');
    expect(instruction.length).toBeLessThanOrEqual(2000);
  });

  it('turns the discovery answer into a skill with only module 1 detailed', () => {
    const skill = parseSkillResearch(answer, profile);
    expect(skill.teacher.name).toBe('Madame Lune');
    expect(skill.roadmap).toHaveLength(3);
    expect(skill.roadmap[0].detailed).toBe(true);
    expect(skill.roadmap[0].lessons[0]).toMatchObject({ id: '1.1', check: 'How do you say goodbye?' });
    expect(skill.roadmap[1].detailed).toBe(false);
    expect(skill.roadmap[1].lessons.map((lesson) => lesson.id)).toEqual(['2.1', '2.2', '2.3']);
    expect(skill.state.currentLesson).toBe('1.1');
  });

  it('stores every section under the Item note limit and reads it back', () => {
    const skill = parseSkillResearch(answer, profile);
    const items = skillItems(skill);
    expect(items.map((item) => item.key)).toEqual(['profile', 'roadmap', 'research', 'state', 'module-1']);
    for (const item of items) expect(item.note.length).toBeLessThanOrEqual(2000);

    const restored = parseSkillItems(items);
    expect(restored).not.toBeNull();
    expect(restored!.student).toEqual(profile);
    expect(restored!.teacher.name).toBe('Madame Lune');
    expect(restored!.roadmap).toEqual(skill.roadmap);
    expect(restored!.research).toEqual(skill.research);
    expect(isTutorProject({ description: tutorSkillProjectDescription(skill) })).toBe(true);
  });

  it('renders one skill.md with the living learner state', () => {
    const skill = parseSkillResearch(answer, profile);
    const md = renderSkillMarkdown(skill);
    expect(md).toContain('# Tutor skill: Madame Lune');
    expect(md).toContain('## Learner state (living)');
    expect(md).toContain('1.1 Hello and goodbye**');
    expect(buildTutorSystemPrompt(skill)).toContain('"research"');
  });

  it('patches the learner state without losing ground', () => {
    const skill = parseSkillResearch(answer, profile);
    const once = applyLearnerPatch(skill.state, {
      currentLesson: '1.2',
      progress: 80,
      mastered: ['bonjour'],
      struggles: ['tu vs vous']
    });
    expect(once.progress).toBe(15);
    expect(once.currentLesson).toBe('1.2');
    const twice = applyLearnerPatch(once, { progress: 5, resolved: ['Tu vs vous'], currentLesson: 'next' });
    expect(twice.progress).toBe(15);
    expect(twice.struggles).toEqual([]);
    expect(twice.currentLesson).toBe('1.2');
  });

  it('prepares the next module ahead and applies H details to it', () => {
    let skill = parseSkillResearch(answer, profile);
    expect(moduleToPrepare(skill)?.number).toBe(2);
    expect(buildModuleResearchInstruction(skill, skill.roadmap[1]).length).toBeLessThanOrEqual(2000);
    skill = applyModuleResearch(
      skill,
      2,
      '{"lessons":[{"title":"1 to 5","objective":"Count to 5.","activity":"Finger game.","check":"Count!"}],"tips":["Count objects"]}'
    );
    expect(skill.roadmap[1].detailed).toBe(true);
    expect(skill.roadmap[1].lessons).toHaveLength(3);
    expect(skill.research.tips).toContain('Count objects');
    expect(parseSkillItems(skillItems(skill))!.roadmap[1].lessons[0].objective).toBe('Count to 5.');
  });

  it('parses a brain turn, a research request, and plain text', () => {
    const turn = parseTutorTurn(
      '{"reply":"Très bien!","state":{"currentLesson":"1.2","progress":10,"mastered":["bonjour"]},"research":null}'
    );
    expect(turn).toMatchObject({ reply: 'Très bien!', research: null, state: { currentLesson: '1.2' } });
    expect(parseTutorTurn('{"reply":"Let me check!","state":{},"research":"French snacks"}').research).toBe(
      'French snacks'
    );
    expect(parseTutorTurn('Just a sentence.')).toEqual({
      reply: 'Just a sentence.',
      research: null,
      state: {}
    });
  });

  it('keeps the H fallback turn under 2,000 characters', () => {
    const skill = parseSkillResearch(answer, profile);
    const long = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? ('tutor' as const) : ('learner' as const),
      text: 'word '.repeat(80)
    }));
    expect(buildHTurnInstruction(skill, long).length).toBeLessThanOrEqual(2000);
  });

  it('reads tutors made before the skill as a one-module skill', () => {
    const skill = legacySkill(
      {
        name: "Adam's probability Tutor",
        description:
          'Created by Tutor Studio\n12 years old · Complete beginner · English\nGames · Calm\nUse dice.'
      },
      [{ name: '1. Chance', note: 'Objective\nKnow chance.\n\nActivity\nFlip a coin.' }]
    );
    expect(skill.student).toMatchObject({ learnerName: 'Adam', subject: 'probability', age: '12' });
    expect(skill.roadmap[0].lessons[0]).toMatchObject({
      id: '1.1',
      title: 'Chance',
      activity: 'Flip a coin.'
    });
  });
});
