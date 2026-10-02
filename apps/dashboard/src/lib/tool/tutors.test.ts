import { describe, expect, it } from 'vitest';
import {
  buildTutorResearchInstruction,
  buildTutorChatInstruction,
  isTutorProject,
  parseTutorChatReply,
  parseTutorJournal,
  parseTutorResearch,
  serializeTutorJournal,
  tutorWelcome,
  tutorProjectDescription,
  tutorIdentity,
  tutorProjectName,
  type TutorProfile
} from './tutors';

const profile: TutorProfile = {
  learnerName: 'Adam',
  age: '12',
  gender: 'Prefer to skip',
  subject: 'probability',
  interests: 'football and space',
  level: 'Complete beginner',
  learningStyle: 'Practical examples',
  tone: 'Warm and encouraging',
  language: 'English'
};

describe('Tutor Studio helpers', () => {
  it('builds a bounded research instruction with a JSON contract', () => {
    const instruction = buildTutorResearchInstruction(profile);
    expect(instruction).toContain('three-lesson micro-course');
    expect(instruction).toContain('Return ONLY valid JSON');
    expect(instruction).toContain('probability');
    expect(instruction).toContain('football and space');
    expect(instruction.length).toBeLessThanOrEqual(2000);
  });

  it('parses JSON even when H wraps it in a code fence', () => {
    const result = parseTutorResearch(
      '```json\n{"tutorName":"Goal Chance","welcome":"Hello Adam!","approach":"Use football.","lessons":[{"title":"Chance","objective":"Know chance.","activity":"Flip a coin."}],"sources":["Example https://example.com"]}\n```',
      profile
    );
    expect(result.tutorName).toBe('Goal Chance');
    expect(result.lessons).toHaveLength(3);
    expect(result.sources).toEqual(['Example https://example.com']);
  });

  it('marks generated projects so the studio can find them again', () => {
    const research = parseTutorResearch(
      '{"lessons":[{"title":"One","objective":"Learn.","activity":"Try."}]}',
      profile
    );
    const description = tutorProjectDescription(profile, research);
    expect(tutorProjectName(profile)).toBe('My probability Tutor');
    expect(isTutorProject({ description })).toBe(true);
    expect(isTutorProject({ description: 'Another project' })).toBe(false);
  });

  it('stores a custom tutor name and Gradium voice in the Project', () => {
    const research = parseTutorResearch(
      '{"lessons":[{"title":"One","objective":"Learn.","activity":"Try."}]}',
      profile
    );
    const description = tutorProjectDescription(profile, research, {
      tutorName: 'Nova',
      voiceId: 'voice_nova',
      voiceStyle: 'Warm guide'
    });
    expect(tutorProjectName(profile, 'Nova')).toBe('Nova · probability');
    expect(tutorIdentity(description)).toEqual({
      tutorName: 'Nova',
      voiceId: 'voice_nova',
      voiceStyle: 'Warm guide'
    });
  });

  it('builds a bounded, lesson-aware tutor turn for H', () => {
    const instruction = buildTutorChatInstruction({
      projectId: 'project-1',
      projectName: "Adam's probability Tutor",
      projectDescription: tutorProjectDescription(
        profile,
        parseTutorResearch('{"lessons":[{"title":"One","objective":"Learn.","activity":"Try."}]}', profile)
      ),
      lessons: [
        { name: '1. Chance', note: 'Objective Understand chance. Activity Flip a coin.' },
        { name: '2. Fractions', note: 'Objective Connect chance to fractions.' }
      ],
      messages: [{ id: 'm1', role: 'learner', text: 'Can we start with a coin?' }],
      progress: 10
    });
    expect(instruction).toContain('[TUTOR_ROOM project=project-1]');
    expect(instruction).toContain('Can we start with a coin?');
    expect(instruction).toContain('Return ONLY valid JSON');
    expect(instruction.length).toBeLessThanOrEqual(2000);
  });

  it('parses a structured tutor reply and never moves progress backwards', () => {
    expect(parseTutorChatReply('{"reply":"Great work. What is 2 × 5?","progress":8}', 12)).toEqual({
      reply: 'Great work. What is 2 × 5?',
      progress: 12
    });
  });

  it('stores a bounded, readable journal and restores the conversation', () => {
    const note = serializeTutorJournal(
      [
        { id: 'a', role: 'tutor', text: 'Welcome!' },
        { id: 'b', role: 'learner', text: 'Give me an exercise.' },
        { id: 'c', role: 'tutor', text: 'What is 3 × 4?' }
      ],
      25,
      '2026-10-02T10:00:00.000Z'
    );
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(parseTutorJournal(note)).toEqual({
      progress: 25,
      messages: [
        { id: 'saved-0', role: 'tutor', text: 'Welcome!' },
        { id: 'saved-1', role: 'learner', text: 'Give me an exercise.' },
        { id: 'saved-2', role: 'tutor', text: 'What is 3 × 4?' }
      ]
    });
  });

  it('creates a friendly welcome from a generated Project', () => {
    expect(
      tutorWelcome(
        "Adam's probability Tutor",
        tutorProjectDescription(profile, {
          tutorName: 'Chance',
          welcome: 'Hello',
          approach: 'Practical',
          lessons: [],
          sources: []
        })
      )
    ).toContain('Hi Adam!');
    expect(
      tutorWelcome(
        'My probability Tutor',
        tutorProjectDescription(profile, {
          tutorName: 'Chance',
          welcome: 'Hello',
          approach: 'Practical',
          lessons: [],
          sources: []
        })
      )
    ).toContain('Hi!');
  });
});
