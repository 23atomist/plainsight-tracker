// ============================================================================
// lib/gears.scad — involute spur/helical gears and Archimedean (ZA) worms.
// Self-contained; no external libraries.
// ============================================================================

function _inv(a) = (tan(a) * 180 / PI) - a;      // involute function, degrees
function _polar(r, a) = [r * cos(a), r * sin(a)];

// 2D involute gear, transverse section. m: module, N: teeth, pa: pressure angle.
// backlash: tooth thinning at the pitch circle (mm).
// add / ded: addendum and dedendum in modules (swap them to cut an internal gear).
module involute_gear_2d(m, N, pa = 20, backlash = 0, steps = 10, add = 1, ded = 1.25) {
    rp = m * N / 2;
    rb = rp * cos(pa);
    ra = rp + add * m;
    rr = rp - ded * m;
    half_t = 90 / N - (backlash / 2) / rp * 180 / PI;   // half tooth angle at pitch circle
    r0 = max(rb, rr);
    flank = [for (i = [0 : steps])
        let(r = r0 + (ra - r0) * i / steps,
            th = half_t + _inv(pa) - _inv(acos(rb / r)))
        _polar(r, th)];
    root_pts = rr < rb ? [_polar(rr, half_t + _inv(pa))] : [];
    tooth = concat(
        root_pts,
        flank,
        [for (i = [steps : -1 : 0]) [flank[i][0], -flank[i][1]]],
        [for (p = root_pts) [p[0], -p[1]]]
    );
    union() {
        circle(r = rr, $fn = max(72, N * 4));
        for (i = [0 : N - 1]) rotate(i * 360 / N) polygon(tooth);
    }
}

// Helical gear, axis = Z, centred at the origin, face width b.
// helix > 0 is right-hand (OpenSCAD twist follows the left-hand rule, so negate).
module helical_gear(m, N, b, helix = 0, pa = 20, backlash = 0) {
    rp = m * N / 2;
    tw = (b * tan(helix) / rp) * 180 / PI;
    linear_extrude(height = b, twist = -tw, slices = max(4, ceil(abs(tw) * 2)), center = true, convexity = 10)
        involute_gear_2d(m, N, pa, backlash);
}

// Worm wheel to mate with worm(m, pd): same hand, helix = worm lead angle.
module worm_wheel(m, N, b, worm_pd, starts = 1, pa = 20, backlash = 0) {
    lead = PI * m * starts;
    gamma = atan(lead / (PI * worm_pd));
    helical_gear(m, N, b, helix = gamma, pa = pa, backlash = backlash);
}

// Radial profile of a ZA worm thread as a function of axial position u (mm),
// tooth centred at u = 0 and repeating every axial pitch p.
function _worm_r(u, p, m, pa, rr, ra, backlash) =
    let(uu = abs(((u % p) + p + p / 2) % p - p / 2),     // fold into [0, p/2]
        half_th = p / 4 - backlash / 2,                 // half thickness at pitch line
        u_tip  = half_th - m * tan(pa),
        u_root = half_th + 1.25 * m * tan(pa))
    uu <= u_tip  ? ra :
    uu >= u_root ? rr :
    ra - (uu - u_tip) / (u_root - u_tip) * (ra - rr);

// 2D cross-section of the worm perpendicular to its axis.
module worm_section_2d(m, pd, starts = 1, pa = 20, backlash = 0, n = 180) {
    p = PI * m;
    lead = p * starts;
    rp = pd / 2; ra = rp + m; rr = rp - 1.25 * m;
    polygon([for (i = [0 : n - 1])
        let(th = i * 360 / n, u = th / 360 * lead)
        _polar(_worm_r(u, p, m, pa, rr, ra, backlash), th)]);
}

// Right-hand Archimedean worm, axis = Z, centred at the origin.
module worm_thread(m, pd, length, starts = 1, pa = 20, backlash = 0) {
    lead = PI * m * starts;
    linear_extrude(height = length, twist = -360 * length / lead,
                   slices = ceil(length / lead * 72), center = true, convexity = 10)
        worm_section_2d(m, pd, starts, pa, backlash);
}

// Simple pinion for the follow focus (spur).
module spur_gear(m, N, b, pa = 10, backlash = 0) {
    linear_extrude(height = b, center = true, convexity = 10)
        involute_gear_2d(m, N, pa, backlash);
}

// Pie slice of radius r from angle a0 to a1 (degrees, CCW from +X).
module pie_2d(r, a0, a1) {
    n = max(2, ceil((a1 - a0) / 2));
    polygon(concat([[0, 0]], [for (i = [0 : n]) let(a = a0 + (a1 - a0) * i / n) [r * cos(a), r * sin(a)]]));
}

// Sector gear: teeth of an N-tooth gear between angles a0..a1, solid to the centre.
module sector_gear_2d(m, N, a0, a1, pa = 20, backlash = 0) {
    intersection() {
        involute_gear_2d(m, N, pa, backlash);
        pie_2d(m * N / 2 + 2 * m, a0, a1);
    }
}

// Internal (ring) gear: N teeth pointing inward, outer radius r_out.
// Teeth are the spaces of an external gear with addendum/dedendum swapped.
module internal_gear_2d(m, N, r_out, pa = 20, backlash = 0) {
    difference() {
        circle(r = r_out, $fn = max(90, N * 3));
        involute_gear_2d(m, N, pa, -backlash, add = 1.25, ded = 1);
    }
}
