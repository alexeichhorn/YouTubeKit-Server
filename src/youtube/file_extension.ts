export enum FileExtension {
   // video
   THREEGP = '3gp',
   TS = 'ts',
   MP4 = 'mp4',
   MPEG = 'mpeg',
   M3U8 = 'm3u8',
   MOV = 'mov',
   VP9 = 'vp9',
   FLV = 'flv',
   M4V = 'm4v',
   MKV = 'mkv',
   MNG = 'mng',
   ASF = 'asf',
   WMV = 'wmv',
   AVI = 'avi',

   // audio
   M4A = 'm4a',
   MP3 = 'mp3',
   MKA = 'mka',
   M3U = 'm3u',
   MID = 'mid',
   OGG = 'ogg',
   WAV = 'wav',
   AAC = 'aac',
   FLAC = 'flac',
   RA = 'ra',

   // audio or video
   WEBM = 'webm',

   // extra
   UNKNOWN = 'unknown',
}

export function fileExtensionFromMimeType(mimeType: string): FileExtension {
   const map: Record<string, FileExtension> = {
      // video
      '3gpp': FileExtension.THREEGP,
      mp2t: FileExtension.TS,
      mp4: FileExtension.MP4,
      mpeg: FileExtension.MPEG,
      mpegurl: FileExtension.M3U8,
      quicktime: FileExtension.MOV,
      webm: FileExtension.WEBM, // Note: webm can be audio or video, maps to WEBM
      vp9: FileExtension.VP9,
      'x-flv': FileExtension.FLV,
      'x-m4v': FileExtension.M4V,
      'x-matroska': FileExtension.MKV,
      'x-mng': FileExtension.MNG,
      'x-mp4-fragmented': FileExtension.MP4,
      'x-ms-asf': FileExtension.ASF,
      'x-ms-wmv': FileExtension.WMV,
      'x-msvideo': FileExtension.AVI,

      // audio
      'audio/mp4': FileExtension.M4A,
      'audio/mpeg': FileExtension.MP3,
      'audio/webm': FileExtension.WEBM,
      'audio/x-matroska': FileExtension.MKA,
      'audio/x-mpegurl': FileExtension.M3U,
      midi: FileExtension.MID,
      ogg: FileExtension.OGG,
      wav: FileExtension.WAV,
      wave: FileExtension.WAV,
      'x-aac': FileExtension.AAC,
      'x-flac': FileExtension.FLAC,
      'x-m4a': FileExtension.M4A,
      'x-realaudio': FileExtension.RA,
      'x-wav': FileExtension.WAV,
   };

   if (map[mimeType]) {
      return map[mimeType];
   }

   const subtype = mimeType.split('/').pop();
   if (subtype && map[subtype]) {
      return map[subtype];
   }

   return FileExtension.UNKNOWN;
}
