use image::{ImageBuffer, Rgba, RgbaImage};
use std::path::PathBuf;

const CELL_W: u32 = 192;
const CELL_H: u32 = 208;
const USED: [u32; 9] = [6, 8, 8, 4, 5, 8, 6, 6, 6];

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut v2: RgbaImage = ImageBuffer::from_pixel(CELL_W * 8, CELL_H * 11, Rgba([0, 0, 0, 0]));
    for (row, frames) in USED.into_iter().enumerate() {
        for column in 0..frames {
            draw_cat(&mut v2, row as u32, column, row as u8, false);
        }
    }
    for direction in 0..16u32 {
        draw_cat(
            &mut v2,
            9 + direction / 8,
            direction % 8,
            direction as u8,
            true,
        );
    }
    v2.save(root.join("fixtures/v2-pet/spritesheet.png"))
        .expect("save v2 fixture");
    let v1 = image::imageops::crop_imm(&v2, 0, 0, CELL_W * 8, CELL_H * 9).to_image();
    v1.save(root.join("fixtures/v1-pet/spritesheet.png"))
        .expect("save v1 fixture");
}

fn draw_cat(image: &mut RgbaImage, row: u32, column: u32, variant: u8, look: bool) {
    let ox = column * CELL_W;
    let oy = row * CELL_H;
    let bob = if look { 0 } else { (column % 3) as i32 * 3 - 3 };
    let center_x = ox as i32 + 96;
    let center_y = oy as i32 + 105 + bob;
    let palette = [
        [244, 194, 99, 255],
        [236, 147, 72, 255],
        [101, 177, 165, 255],
        [235, 118, 111, 255],
        [126, 154, 213, 255],
        [173, 128, 191, 255],
        [224, 180, 88, 255],
        [102, 164, 132, 255],
        [203, 133, 90, 255],
    ];
    let color = palette[variant as usize % palette.len()];
    circle(image, center_x, center_y + 30, 55, color);
    circle(image, center_x, center_y - 18, 62, color);
    triangle(
        image,
        (center_x - 48, center_y - 50),
        (center_x - 24, center_y - 104),
        (center_x - 3, center_y - 58),
        color,
    );
    triangle(
        image,
        (center_x + 48, center_y - 50),
        (center_x + 24, center_y - 104),
        (center_x + 3, center_y - 58),
        color,
    );
    let angle = if look {
        variant as f32 * std::f32::consts::TAU / 16.0
    } else {
        0.0
    };
    let eye_dx = angle.sin() * 7.0;
    let eye_dy = -angle.cos() * 7.0;
    circle(image, center_x - 22, center_y - 20, 10, [35, 55, 56, 255]);
    circle(image, center_x + 22, center_y - 20, 10, [35, 55, 56, 255]);
    circle(
        image,
        center_x - 22 + eye_dx as i32,
        center_y - 20 + eye_dy as i32,
        3,
        [255, 255, 255, 255],
    );
    circle(
        image,
        center_x + 22 + eye_dx as i32,
        center_y - 20 + eye_dy as i32,
        3,
        [255, 255, 255, 255],
    );
    circle(image, center_x, center_y + 4, 6, [210, 93, 91, 255]);
}

fn circle(image: &mut RgbaImage, cx: i32, cy: i32, radius: i32, color: [u8; 4]) {
    for y in cy - radius..=cy + radius {
        for x in cx - radius..=cx + radius {
            if x >= 0
                && y >= 0
                && x < image.width() as i32
                && y < image.height() as i32
                && (x - cx).pow(2) + (y - cy).pow(2) <= radius.pow(2)
            {
                image.put_pixel(x as u32, y as u32, Rgba(color));
            }
        }
    }
}

fn triangle(image: &mut RgbaImage, a: (i32, i32), b: (i32, i32), c: (i32, i32), color: [u8; 4]) {
    let min_x = a.0.min(b.0).min(c.0);
    let max_x = a.0.max(b.0).max(c.0);
    let min_y = a.1.min(b.1).min(c.1);
    let max_y = a.1.max(b.1).max(c.1);
    let sign = |p: (i32, i32), q: (i32, i32), r: (i32, i32)| {
        (p.0 - r.0) * (q.1 - r.1) - (q.0 - r.0) * (p.1 - r.1)
    };
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let p = (x, y);
            let d1 = sign(p, a, b);
            let d2 = sign(p, b, c);
            let d3 = sign(p, c, a);
            if !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
                && x >= 0
                && y >= 0
                && x < image.width() as i32
                && y < image.height() as i32
            {
                image.put_pixel(x as u32, y as u32, Rgba(color));
            }
        }
    }
}
