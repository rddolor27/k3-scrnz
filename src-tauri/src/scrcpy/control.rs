use serde::Deserialize;
use thiserror::Error;

pub const KEYCODE_POWER: i32 = 26;
pub const KEYCODE_SLEEP: i32 = 223;
/// Never sent: it puts an awake Gemini to sleep (SPEC section 12).
pub const KEYCODE_WAKEUP: i32 = 224;

const TEXT_MAX: usize = 300;
const CLIPBOARD_MAX: usize = 262_130;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ControlError {
    #[error("KEYCODE_WAKEUP (224) is never sent: it puts the Gemini to sleep")]
    WakeupForbidden,
    #[error("input for a {got_w}x{got_h} screen, but the session is {w}x{h}")]
    SizeMismatch {
        got_w: u16,
        got_h: u16,
        w: u16,
        h: u16,
    },
    #[error("touch action {0} is not allowed (only down, up, move, hover)")]
    TouchAction(u8),
    #[error("key action {0} is not allowed (only down and up)")]
    KeyAction(u8),
    #[error("keycode {0} goes through the power button only (never a blind POWER)")]
    PowerForbidden(i32),
    #[error("copy key {0} is not allowed (only 0 none, 1 copy, 2 cut)")]
    CopyKey(u8),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    Key {
        action: u8,
        keycode: i32,
        repeat: i32,
        meta: i32,
    },
    Text(String),
    Touch {
        action: u8,
        pointer_id: u64,
        x: i32,
        y: i32,
        w: u16,
        h: u16,
        pressure: f32,
        action_button: i32,
        buttons: i32,
    },
    Scroll {
        x: i32,
        y: i32,
        w: u16,
        h: u16,
        hscroll: f32,
        vscroll: f32,
        buttons: i32,
    },
    BackOrScreenOn {
        action: u8,
    },
    ExpandNotifications,
    CollapsePanels,
    GetClipboard {
        copy_key: u8,
    },
    SetClipboard {
        sequence: u64,
        paste: bool,
        text: String,
    },
    ResetVideo,
    RotateDevice,
}

fn u16fp(f: f32) -> u16 {
    let u = (f.max(0.0) * 65536.0) as u32;
    if u >= 0xffff { 0xffff } else { u as u16 }
}

fn i16fp(f: f32) -> i16 {
    let i = (f.clamp(-1.0, 1.0) * 32768.0) as i32;
    if i >= 0x7fff { 0x7fff } else { i as i16 }
}

fn truncate_utf8(s: &str, max: usize) -> &[u8] {
    if s.len() <= max {
        return s.as_bytes();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s.as_bytes()[..end]
}

fn split_utf8(mut s: &str, max: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    while !s.is_empty() {
        let len = truncate_utf8(s, max)
            .len()
            .max(s.chars().next().map_or(1, char::len_utf8));
        let (head, tail) = s.split_at(len);
        parts.push(head);
        s = tail;
    }
    parts
}

pub fn serialize(m: &Control) -> Result<Vec<u8>, ControlError> {
    let mut b = Vec::with_capacity(32);
    let pos = |b: &mut Vec<u8>, x: i32, y: i32, w: u16, h: u16| {
        b.extend(x.to_be_bytes());
        b.extend(y.to_be_bytes());
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
    };
    match m {
        Control::Key {
            action,
            keycode,
            repeat,
            meta,
        } => {
            if *keycode == KEYCODE_WAKEUP {
                return Err(ControlError::WakeupForbidden);
            }
            b.push(0);
            b.push(*action);
            b.extend(keycode.to_be_bytes());
            b.extend(repeat.to_be_bytes());
            b.extend(meta.to_be_bytes());
        }
        Control::Text(text) => {
            let s = truncate_utf8(text, TEXT_MAX);
            b.push(1);
            b.extend((s.len() as u32).to_be_bytes());
            b.extend(s);
        }
        Control::Touch {
            action,
            pointer_id,
            x,
            y,
            w,
            h,
            pressure,
            action_button,
            buttons,
        } => {
            b.push(2);
            b.push(*action);
            b.extend(pointer_id.to_be_bytes());
            pos(&mut b, *x, *y, *w, *h);
            b.extend(u16fp(*pressure).to_be_bytes());
            b.extend(action_button.to_be_bytes());
            b.extend(buttons.to_be_bytes());
        }
        Control::Scroll {
            x,
            y,
            w,
            h,
            hscroll,
            vscroll,
            buttons,
        } => {
            b.push(3);
            pos(&mut b, *x, *y, *w, *h);
            b.extend(i16fp(hscroll / 16.0).to_be_bytes());
            b.extend(i16fp(vscroll / 16.0).to_be_bytes());
            b.extend(buttons.to_be_bytes());
        }
        Control::BackOrScreenOn { action } => {
            b.push(4);
            b.push(*action);
        }
        Control::ExpandNotifications => b.push(5),
        Control::CollapsePanels => b.push(7),
        Control::GetClipboard { copy_key } => {
            b.push(8);
            b.push(*copy_key);
        }
        Control::SetClipboard {
            sequence,
            paste,
            text,
        } => {
            let s = truncate_utf8(text, CLIPBOARD_MAX);
            b.push(9);
            b.extend(sequence.to_be_bytes());
            b.push(u8::from(*paste));
            b.extend((s.len() as u32).to_be_bytes());
            b.extend(s);
        }
        Control::ResetVideo => b.push(17),
        Control::RotateDevice => b.push(11),
    }
    Ok(b)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Input {
    Key {
        action: u8,
        keycode: i32,
        #[serde(default)]
        repeat: i32,
        #[serde(default)]
        meta: i32,
    },
    Text {
        text: String,
    },
    Touch {
        action: u8,
        pointer_id: i64,
        x: i32,
        y: i32,
        w: u16,
        h: u16,
        pressure: f32,
        action_button: i32,
        buttons: i32,
    },
    Scroll {
        x: i32,
        y: i32,
        w: u16,
        h: u16,
        hscroll: f32,
        vscroll: f32,
        buttons: i32,
    },
    BackOrScreenOn {
        action: u8,
    },
    SetClipboard {
        text: String,
        paste: bool,
    },
    GetClipboard {
        copy_key: u8,
    },
    ResetVideo {
        #[serde(default)]
        force: bool,
    },
    ExpandNotifications,
    CollapsePanels,
    RotateDevice,
}

fn check_size(got: (u16, u16), session: (u16, u16)) -> Result<(), ControlError> {
    if got == session {
        Ok(())
    } else {
        Err(ControlError::SizeMismatch {
            got_w: got.0,
            got_h: got.1,
            w: session.0,
            h: session.1,
        })
    }
}

/// Positions must use the session size or the server drops them silently.
pub fn to_controls(input: Input, session: (u16, u16)) -> Result<Vec<Control>, ControlError> {
    Ok(match input {
        Input::Key {
            action,
            keycode,
            repeat,
            meta,
        } => {
            if keycode == KEYCODE_WAKEUP {
                return Err(ControlError::WakeupForbidden);
            }
            if keycode == KEYCODE_POWER || keycode == KEYCODE_SLEEP {
                return Err(ControlError::PowerForbidden(keycode));
            }
            if action > 1 {
                return Err(ControlError::KeyAction(action));
            }
            vec![Control::Key {
                action,
                keycode,
                repeat,
                meta,
            }]
        }
        Input::Text { text } => split_utf8(&text, TEXT_MAX)
            .into_iter()
            .map(|part| Control::Text(part.to_owned()))
            .collect(),
        Input::Touch {
            action,
            pointer_id,
            x,
            y,
            w,
            h,
            pressure,
            action_button,
            buttons,
        } => {
            if !matches!(action, 0 | 1 | 2 | 7) {
                return Err(ControlError::TouchAction(action));
            }
            check_size((w, h), session)?;
            vec![Control::Touch {
                action,
                // The mouse is pointer -1, i.e. 0xFFFF_FFFF_FFFF_FFFF.
                pointer_id: pointer_id as u64,
                x,
                y,
                w,
                h,
                pressure,
                action_button,
                buttons,
            }]
        }
        Input::Scroll {
            x,
            y,
            w,
            h,
            hscroll,
            vscroll,
            buttons,
        } => {
            check_size((w, h), session)?;
            vec![Control::Scroll {
                x,
                y,
                w,
                h,
                hscroll,
                vscroll,
                buttons,
            }]
        }
        Input::BackOrScreenOn { action } => {
            if action > 1 {
                return Err(ControlError::KeyAction(action));
            }
            vec![Control::BackOrScreenOn { action }]
        }
        Input::SetClipboard { text, paste } => vec![Control::SetClipboard {
            sequence: 0,
            paste,
            text,
        }],
        Input::GetClipboard { copy_key } => {
            if copy_key > 2 {
                return Err(ControlError::CopyKey(copy_key));
            }
            vec![Control::GetClipboard { copy_key }]
        }
        Input::ResetVideo { .. } => vec![Control::ResetVideo],
        Input::ExpandNotifications => vec![Control::ExpandNotifications],
        Input::CollapsePanels => vec![Control::CollapsePanels],
        Input::RotateDevice => vec![Control::RotateDevice],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn serializes_inject_keycode() {
        // SPEC section 15: action 1, keycode 66, repeat 5, meta 0x41.
        let bytes = serialize(&Control::Key {
            action: 1,
            keycode: 66,
            repeat: 5,
            meta: 0x41,
        })
        .unwrap();
        assert_eq!(hex(&bytes), "0001000000420000000500000041");
    }

    #[test]
    fn serializes_inject_touch() {
        // SPEC section 15.
        let bytes = serialize(&Control::Touch {
            action: 0,
            pointer_id: 0x1234_5678_8765_4321,
            x: 100,
            y: 200,
            w: 1080,
            h: 1920,
            pressure: 1.0,
            action_button: 1,
            buttons: 1,
        })
        .unwrap();
        assert_eq!(
            hex(&bytes),
            "0200123456788765432100000064000000c804380780ffff0000000100000001"
        );
    }

    #[test]
    fn serializes_scroll_fixed_point() {
        // SPEC section 15: hscroll 16 / vscroll -16 → 7fff 8000.
        let bytes = serialize(&Control::Scroll {
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            hscroll: 16.0,
            vscroll: -16.0,
            buttons: 0,
        })
        .unwrap();
        assert_eq!(hex(&bytes[13..17]), "7fff8000");
    }

    #[test]
    fn refuses_wakeup() {
        let wakeup = Control::Key {
            action: 0,
            keycode: KEYCODE_WAKEUP,
            repeat: 0,
            meta: 0,
        };
        assert_eq!(serialize(&wakeup), Err(ControlError::WakeupForbidden));
        let input = Input::Key {
            action: 0,
            keycode: KEYCODE_WAKEUP,
            repeat: 0,
            meta: 0,
        };
        assert_eq!(
            to_controls(input, (1920, 1072)),
            Err(ControlError::WakeupForbidden)
        );
    }
}
