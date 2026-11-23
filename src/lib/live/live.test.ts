import {test,expect} from 'vitest';
import {playlist} from './hls';
test('Live playlist accepts bounded relative fMP4 only',()=>{
 expect(playlist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-5.m4s')).toEqual({sequence:5,files:['seg-5.m4s']});
 for(const file of ['https://other.test/seg-5.m4s','../seg-5.m4s','/api/file','seg-12345678.m4s'])expect(()=>playlist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-MAP:URI="init.mp4"\n'+file)).toThrow();
 expect(()=>playlist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n'+Array(7).fill('seg-0.m4s').join('\n'))).toThrow();
});
