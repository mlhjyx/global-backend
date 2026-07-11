import { describe, expect, it } from 'vitest';
import {
  detectAtsBoard,
  atsApiUrl,
  parseAtsJobs,
  buildHiringFromAtsJobs,
} from './ats-boards';

/**
 * ATS 招聘板适配（Greenhouse/Lever/Ashby）纯解析 + 检测单测。
 * fixtures 按**实测真实响应形状**建（Greenhouse gitlab / Ashby ramp 真拉确认字段；Lever 按官方 schema）。
 */

describe('detectAtsBoard — 从 HTML 检测 ATS 供应商 + token', () => {
  it('Greenhouse embed（?for=TOKEN）', () => {
    const html = `<iframe src="https://boards.greenhouse.io/embed/job_board?for=acmecorp&b=1"></iframe>`;
    expect(detectAtsBoard(html)).toEqual({ vendor: 'greenhouse', token: 'acmecorp' });
  });
  it('Greenhouse boards-api 直链', () => {
    expect(detectAtsBoard('fetch("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs")')).toEqual({
      vendor: 'greenhouse',
      token: 'gitlab',
    });
  });
  it('Greenhouse data-board-token 属性', () => {
    expect(detectAtsBoard(`<div data-board-token="figma"></div>`)).toEqual({ vendor: 'greenhouse', token: 'figma' });
  });
  it('Greenhouse 公开 board 直链', () => {
    expect(detectAtsBoard(`<a href="https://boards.greenhouse.io/airtable">Jobs</a>`)).toEqual({
      vendor: 'greenhouse',
      token: 'airtable',
    });
  });
  it('Lever（jobs.lever.co / api.lever.co）', () => {
    expect(detectAtsBoard(`<a href="https://jobs.lever.co/voiceflow">Careers</a>`)).toEqual({
      vendor: 'lever',
      token: 'voiceflow',
    });
    expect(detectAtsBoard('https://api.lever.co/v0/postings/plaid?mode=json')).toEqual({
      vendor: 'lever',
      token: 'plaid',
    });
  });
  it('Ashby（jobs.ashbyhq.com / posting-api）', () => {
    expect(detectAtsBoard(`<iframe src="https://jobs.ashbyhq.com/ramp"></iframe>`)).toEqual({
      vendor: 'ashby',
      token: 'ramp',
    });
    expect(detectAtsBoard('https://api.ashbyhq.com/posting-api/job-board/linear')).toEqual({
      vendor: 'ashby',
      token: 'linear',
    });
  });
  it('embed 无 for= → 不把 "embed" 误当 token（denylist）', () => {
    expect(detectAtsBoard('https://boards.greenhouse.io/embed/job_board')).toBeNull();
  });
  it('无 ATS 签名 / 空 → null', () => {
    expect(detectAtsBoard('<html><body>no ats here</body></html>')).toBeNull();
    expect(detectAtsBoard('')).toBeNull();
  });
});

describe('atsApiUrl — 公开 JSON API URL', () => {
  it('三家各自端点', () => {
    expect(atsApiUrl({ vendor: 'greenhouse', token: 'gitlab' })).toBe(
      'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true',
    );
    expect(atsApiUrl({ vendor: 'lever', token: 'plaid' })).toBe('https://api.lever.co/v0/postings/plaid?mode=json');
    expect(atsApiUrl({ vendor: 'ashby', token: 'ramp' })).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/ramp',
    );
  });
});

describe('parseAtsJobs — 各 ATS JSON → 归一 AtsJob[]（实测形状）', () => {
  it('Greenhouse（location.name / departments[].name / updated_at）', () => {
    const json = {
      jobs: [
        {
          title: 'Account Executive - Italy',
          updated_at: '2026-06-05T16:18:10-04:00',
          location: { name: 'Remote, Italy' },
          departments: [{ name: 'EMEA - Commercial' }],
        },
        { title: '', location: { name: 'X' } }, // 空标题被过滤
      ],
    };
    expect(parseAtsJobs('greenhouse', json)).toEqual([
      {
        title: 'Account Executive - Italy',
        department: 'EMEA - Commercial',
        location: 'Remote, Italy',
        updatedAt: '2026-06-05T20:18:10.000Z',
      },
    ]);
  });
  it('Lever（text / categories / createdAt ms epoch）', () => {
    const json = [
      {
        text: 'Strategic Sourcing Manager',
        categories: { department: 'Operations', team: 'Supply Chain', location: 'Berlin' },
        createdAt: 1_700_000_000_000,
      },
    ];
    expect(parseAtsJobs('lever', json)).toEqual([
      {
        title: 'Strategic Sourcing Manager',
        department: 'Operations',
        location: 'Berlin',
        updatedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });
  it('Ashby（department / location / publishedAt 兜底 updatedAt）', () => {
    const json = {
      jobs: [
        {
          title: 'Head of Procurement',
          department: 'Operations',
          team: 'Ops',
          location: 'Remote (US)',
          publishedAt: '2026-07-07T20:47:09.753+00:00',
        },
      ],
    };
    expect(parseAtsJobs('ashby', json)).toEqual([
      {
        title: 'Head of Procurement',
        department: 'Operations',
        location: 'Remote (US)',
        updatedAt: '2026-07-07T20:47:09.753Z',
      },
    ]);
  });
  it('结构不符 / unknown → 空数组（fail-safe）', () => {
    expect(parseAtsJobs('greenhouse', null)).toEqual([]);
    expect(parseAtsJobs('greenhouse', { jobs: 'nope' })).toEqual([]);
    expect(parseAtsJobs('lever', {})).toEqual([]);
    expect(parseAtsJobs('ashby', 42)).toEqual([]);
  });
});

describe('buildHiringFromAtsJobs — 岗位 → 招聘信号', () => {
  const jobs = [
    { title: 'Strategic Sourcing Manager', department: 'Ops', location: 'Berlin', updatedAt: '2026-05-01T00:00:00.000Z' },
    { title: 'Frontend Engineer', department: 'Eng', location: 'Remote', updatedAt: '2026-06-01T00:00:00.000Z' },
    { title: 'Strategic Sourcing Manager', department: 'Ops', location: 'Berlin', updatedAt: '2026-04-01T00:00:00.000Z' }, // 重复标题
  ];
  it('去重 + most_recent_at 取最新 + source 带 vendor', () => {
    const h = buildHiringFromAtsJobs('greenhouse', jobs);
    expect(h).toEqual({
      source: 'ats:greenhouse',
      open_roles: 3,
      titles: ['Strategic Sourcing Manager', 'Frontend Engineer'],
      departments: ['Ops', 'Eng'],
      locations: ['Berlin', 'Remote'],
      most_recent_at: '2026-06-01T00:00:00.000Z',
    });
  });
  it('空岗位 → null', () => {
    expect(buildHiringFromAtsJobs('lever', [])).toBeNull();
  });
  it('无可解析时间 → most_recent_at=null', () => {
    const h = buildHiringFromAtsJobs('ashby', [{ title: 'X', department: null, location: null, updatedAt: null }]);
    expect(h?.most_recent_at).toBeNull();
    expect(h?.departments).toEqual([]);
  });
});
