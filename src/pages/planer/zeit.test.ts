import {describe,expect,it} from 'vitest';
import {local,toUtc} from './zeit';

describe('vorhandene Termininstanten bearbeiten',()=>{
  it('erhält die zweite Herbststunde samt Sekunden beim unveränderten Feld',()=>{
    const start='2027-10-31T01:30:24.123Z';
    const end='2027-10-31T02:30:24.123Z';
    expect(toUtc(local(start),start)).toBe(start);
    expect(toUtc(local(end),end)).toBe(end);
    expect(Date.parse(toUtc(local(end),end))-Date.parse(toUtc(local(start),start))).toBe(3600000);
  });
  it('verwendet erste Herbststunde nur für neue oder tatsächlich andere Ortszeiten',()=>{
    expect(toUtc('2027-10-31T02:30')).toBe('2027-10-31T00:30:00.000Z');
    expect(toUtc('2027-10-31T02:45','2027-10-31T01:30:24.123Z')).toBe('2027-10-31T00:45:00.000Z');
    expect(()=>toUtc('2027-03-28T02:30')).toThrow();
  });
});
