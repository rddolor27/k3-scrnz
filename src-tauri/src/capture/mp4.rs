use std::io::{self, Seek, SeekFrom, Write};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TIMESCALE: u32 = 90_000;
const MOVIE_TIMESCALE: u32 = 1000;
const MAX_LAST_SAMPLE: Duration = Duration::from_secs(60);
const MAC_EPOCH_OFFSET: u64 = 2_082_844_800;
const IDENTITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

struct Sample {
    offset: u32,
    size: u32,
    duration: u32,
    key: bool,
}

pub struct Finished {
    pub bytes: u64,
    pub duration_ms: u64,
}

pub struct Mp4<W: Write + Seek> {
    out: W,
    width: u16,
    height: u16,
    sps: Vec<u8>,
    pps: Vec<u8>,
    mdat_start: u64,
    pos: u64,
    samples: Vec<Sample>,
    first_pts: Option<u64>,
    last_pts: u64,
    last_arrived: Option<Instant>,
}

impl<W: Write + Seek> Mp4<W> {
    pub fn new(mut out: W, width: u16, height: u16, sps: &[u8], pps: &[u8]) -> io::Result<Self> {
        let mut head = Vec::new();
        put_box(&mut head, b"ftyp", |b| {
            b.extend_from_slice(b"isom");
            put_u32(b, 512);
            for brand in [b"isom", b"iso2", b"avc1", b"mp41"] {
                b.extend_from_slice(brand);
            }
        });
        let mdat_start = head.len() as u64;
        // The 32-bit mdat size is patched in `finish`.
        put_u32(&mut head, 0);
        head.extend_from_slice(b"mdat");
        out.write_all(&head)?;
        Ok(Self {
            out,
            width,
            height,
            sps: sps.to_vec(),
            pps: pps.to_vec(),
            mdat_start,
            pos: head.len() as u64,
            samples: Vec::new(),
            first_pts: None,
            last_pts: 0,
            last_arrived: None,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn written(&self) -> u64 {
        self.pos
    }

    pub fn push(
        &mut self,
        sample: &[u8],
        key: bool,
        pts_us: u64,
        arrived: Instant,
    ) -> io::Result<()> {
        let size = u32::try_from(sample.len()).map_err(|_| io::Error::other("sample too large"))?;
        let offset = u32::try_from(self.pos).map_err(|_| io::Error::other("file too large"))?;
        self.out.write_all(sample)?;
        self.pos += u64::from(size);

        let first = *self.first_pts.get_or_insert(pts_us);
        let pts = pts_us.max(self.last_pts).max(first);
        if let Some(prev) = self.samples.last_mut() {
            let delta = ticks(pts - first).saturating_sub(ticks(self.last_pts - first));
            prev.duration = u32::try_from(delta).unwrap_or(u32::MAX).max(1);
        }
        self.last_pts = pts;
        self.last_arrived = Some(arrived);
        self.samples.push(Sample {
            offset,
            size,
            duration: 1,
            key,
        });
        Ok(())
    }

    pub fn finish(mut self) -> io::Result<Finished> {
        // A static screen sends nothing, so the last frame lasts until now.
        if let (Some(last), Some(arrived)) = (self.samples.last_mut(), self.last_arrived) {
            let held = arrived.elapsed().min(MAX_LAST_SAMPLE);
            last.duration = u32::try_from(duration_ticks(held))
                .unwrap_or(u32::MAX)
                .max(1);
        }
        let total: u64 = self.samples.iter().map(|s| u64::from(s.duration)).sum();
        let moov = self.moov(total);
        if u32::try_from(moov.len()).is_err() {
            return Err(io::Error::other("moov too large"));
        }
        let mdat_size = u32::try_from(self.pos - self.mdat_start)
            .map_err(|_| io::Error::other("mdat too large"))?;
        self.out.write_all(&moov)?;
        self.out.seek(SeekFrom::Start(self.mdat_start))?;
        self.out.write_all(&mdat_size.to_be_bytes())?;
        self.out.flush()?;
        Ok(Finished {
            bytes: self.pos + moov.len() as u64,
            duration_ms: total * u64::from(MOVIE_TIMESCALE) / u64::from(TIMESCALE),
        })
    }

    fn moov(&self, total_ticks: u64) -> Vec<u8> {
        let now = mac_now();
        let movie_duration =
            u32::try_from(total_ticks * u64::from(MOVIE_TIMESCALE) / u64::from(TIMESCALE))
                .unwrap_or(u32::MAX);
        let media_duration = u32::try_from(total_ticks).unwrap_or(u32::MAX);
        let mut out = Vec::new();
        put_box(&mut out, b"moov", |out| {
            put_box(out, b"mvhd", |b| {
                put_u32(b, 0);
                put_u32(b, now);
                put_u32(b, now);
                put_u32(b, MOVIE_TIMESCALE);
                put_u32(b, movie_duration);
                put_u32(b, 0x0001_0000);
                put_u16(b, 0x0100);
                b.extend_from_slice(&[0; 10]);
                put_matrix(b);
                b.extend_from_slice(&[0; 24]);
                put_u32(b, 2);
            });
            put_box(out, b"trak", |out| {
                put_box(out, b"tkhd", |b| {
                    // enabled | in movie
                    put_u32(b, 3);
                    put_u32(b, now);
                    put_u32(b, now);
                    put_u32(b, 1);
                    put_u32(b, 0);
                    put_u32(b, movie_duration);
                    b.extend_from_slice(&[0; 8]);
                    put_u16(b, 0);
                    put_u16(b, 0);
                    put_u16(b, 0);
                    put_u16(b, 0);
                    put_matrix(b);
                    put_u32(b, u32::from(self.width) << 16);
                    put_u32(b, u32::from(self.height) << 16);
                });
                put_box(out, b"mdia", |out| {
                    put_box(out, b"mdhd", |b| {
                        put_u32(b, 0);
                        put_u32(b, now);
                        put_u32(b, now);
                        put_u32(b, TIMESCALE);
                        put_u32(b, media_duration);
                        // "und"
                        put_u16(b, 0x55C4);
                        put_u16(b, 0);
                    });
                    put_box(out, b"hdlr", |b| {
                        put_u32(b, 0);
                        put_u32(b, 0);
                        b.extend_from_slice(b"vide");
                        b.extend_from_slice(&[0; 12]);
                        b.extend_from_slice(b"VideoHandler\0");
                    });
                    put_box(out, b"minf", |out| {
                        put_box(out, b"vmhd", |b| {
                            put_u32(b, 1);
                            b.extend_from_slice(&[0; 8]);
                        });
                        put_box(out, b"dinf", |out| {
                            put_box(out, b"dref", |out| {
                                put_u32(out, 0);
                                put_u32(out, 1);
                                put_box(out, b"url ", |b| put_u32(b, 1));
                            });
                        });
                        put_box(out, b"stbl", |out| self.stbl(out));
                    });
                });
            });
        });
        out
    }

    fn stbl(&self, out: &mut Vec<u8>) {
        put_box(out, b"stsd", |out| {
            put_u32(out, 0);
            put_u32(out, 1);
            put_box(out, b"avc1", |out| {
                out.extend_from_slice(&[0; 6]);
                put_u16(out, 1);
                out.extend_from_slice(&[0; 16]);
                put_u16(out, self.width);
                put_u16(out, self.height);
                // 72 dpi both ways
                put_u32(out, 0x0048_0000);
                put_u32(out, 0x0048_0000);
                put_u32(out, 0);
                put_u16(out, 1);
                out.extend_from_slice(&[0; 32]);
                put_u16(out, 0x0018);
                put_u16(out, 0xFFFF);
                put_box(out, b"avcC", |b| self.avcc(b));
            });
        });

        let mut runs: Vec<(u32, u32)> = Vec::new();
        for sample in &self.samples {
            match runs.last_mut() {
                Some((count, duration)) if *duration == sample.duration => *count += 1,
                _ => runs.push((1, sample.duration)),
            }
        }
        put_box(out, b"stts", |b| {
            put_u32(b, 0);
            put_u32(b, count(runs.len()));
            for (n, duration) in &runs {
                put_u32(b, *n);
                put_u32(b, *duration);
            }
        });
        put_box(out, b"stss", |b| {
            put_u32(b, 0);
            let keys = self.samples.iter().filter(|s| s.key).count();
            put_u32(b, count(keys));
            for (i, _) in self.samples.iter().enumerate().filter(|(_, s)| s.key) {
                put_u32(b, count(i + 1));
            }
        });
        put_box(out, b"stsz", |b| {
            put_u32(b, 0);
            put_u32(b, 0);
            put_u32(b, count(self.samples.len()));
            for sample in &self.samples {
                put_u32(b, sample.size);
            }
        });
        put_box(out, b"stsc", |b| {
            put_u32(b, 0);
            put_u32(b, 1);
            put_u32(b, 1);
            put_u32(b, 1);
            put_u32(b, 1);
        });
        put_box(out, b"stco", |b| {
            put_u32(b, 0);
            put_u32(b, count(self.samples.len()));
            for sample in &self.samples {
                put_u32(b, sample.offset);
            }
        });
    }

    fn avcc(&self, b: &mut Vec<u8>) {
        b.push(1);
        // The SPS NAL header comes first: profile, compatibility, level.
        b.extend_from_slice(self.sps.get(1..4).unwrap_or(&[0; 3]));
        // 4-byte NAL lengths, 1 SPS, 1 PPS.
        b.push(0xFF);
        b.push(0xE1);
        put_u16(b, u16::try_from(self.sps.len()).unwrap_or(u16::MAX));
        b.extend_from_slice(&self.sps);
        b.push(1);
        put_u16(b, u16::try_from(self.pps.len()).unwrap_or(u16::MAX));
        b.extend_from_slice(&self.pps);
    }
}

pub fn annexb_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut nals = Vec::new();
    let mut start = None;
    let mut i = 0;
    while i + 3 <= data.len() {
        // A start code needs data[i + 2] to be 0 or 1, so anything larger skips 3 bytes.
        match data[i + 2] {
            0 => i += 1,
            1 if data[i] == 0 && data[i + 1] == 0 => {
                if let Some(s) = start {
                    push_nal(&mut nals, &data[s..i]);
                }
                start = Some(i + 3);
                i += 3;
            }
            _ => i += 3,
        }
    }
    if let Some(s) = start {
        push_nal(&mut nals, &data[s..]);
    }
    nals
}

fn push_nal<'a>(nals: &mut Vec<&'a [u8]>, nal: &'a [u8]) {
    // Trailing zeros are the leading zero of a 4-byte start code, never NAL data.
    let end = nal.iter().rposition(|b| *b != 0).map_or(0, |p| p + 1);
    if end > 0 {
        nals.push(&nal[..end]);
    }
}

pub fn length_prefixed(nals: &[&[u8]], out: &mut Vec<u8>) {
    for nal in nals {
        put_u32(out, u32::try_from(nal.len()).unwrap_or(u32::MAX));
        out.extend_from_slice(nal);
    }
}

fn put_box(out: &mut Vec<u8>, kind: &[u8; 4], body: impl FnOnce(&mut Vec<u8>)) {
    let start = out.len();
    put_u32(out, 0);
    out.extend_from_slice(kind);
    body(out);
    let size = u32::try_from(out.len() - start).unwrap_or(u32::MAX);
    out[start..start + 4].copy_from_slice(&size.to_be_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_matrix(out: &mut Vec<u8>) {
    for value in IDENTITY_MATRIX {
        put_u32(out, value);
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn ticks(us: u64) -> u64 {
    u64::try_from(u128::from(us) * u128::from(TIMESCALE) / 1_000_000).unwrap_or(u64::MAX)
}

fn duration_ticks(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros().saturating_mul(u128::from(TIMESCALE)) / 1_000_000)
        .unwrap_or(u64::MAX)
}

fn mac_now() -> u32 {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    u32::try_from(unix + MAC_EPOCH_OFFSET).unwrap_or(0)
}
