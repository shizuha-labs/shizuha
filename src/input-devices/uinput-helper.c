/*
 * uinput-helper — Creates virtual mouse + keyboard via /dev/uinput.
 *
 * Reads JSON commands from stdin (one per line), writes Linux input events.
 * Designed to be spawned by Node.js and controlled via stdin pipe.
 *
 * Commands:
 *   {"t":"m","x":100,"y":200}          — mouse move (relative)
 *   {"t":"ma","x":500,"y":300}         — mouse move (absolute)
 *   {"t":"mb","b":1,"v":1}             — mouse button (b=BTN_LEFT/RIGHT/MIDDLE, v=1 press, v=0 release)
 *   {"t":"ms","d":-3}                  — mouse scroll (d = delta, negative = up)
 *   {"t":"k","c":28,"v":1}             — key event (c = keycode, v=1 press, v=0 release)
 *   {"t":"q"}                          — quit
 *
 * Build: gcc -o uinput-helper src/input-devices/uinput-helper.c
 * Usage: ./uinput-helper < commands.jsonl
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <linux/uinput.h>

static int fd_mouse = -1;
static int fd_kbd = -1;

static void emit(int fd, int type, int code, int val) {
    struct input_event ev = {0};
    ev.type = type;
    ev.code = code;
    ev.value = val;
    write(fd, &ev, sizeof(ev));
}

static void sync_event(int fd) {
    emit(fd, EV_SYN, SYN_REPORT, 0);
}

static int screen_w = 1920;
static int screen_h = 1080;

static int setup_mouse(void) {
    int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fd < 0) { perror("open /dev/uinput (mouse)"); return -1; }

    /* Enable event types */
    ioctl(fd, UI_SET_EVBIT, EV_REL);
    ioctl(fd, UI_SET_EVBIT, EV_ABS);
    ioctl(fd, UI_SET_EVBIT, EV_KEY);

    /* Relative axes (for relative movement) */
    ioctl(fd, UI_SET_RELBIT, REL_X);
    ioctl(fd, UI_SET_RELBIT, REL_Y);
    ioctl(fd, UI_SET_RELBIT, REL_WHEEL);

    /* Absolute axes (for absolute positioning) */
    ioctl(fd, UI_SET_ABSBIT, ABS_X);
    ioctl(fd, UI_SET_ABSBIT, ABS_Y);

    /* Mouse buttons */
    ioctl(fd, UI_SET_KEYBIT, BTN_LEFT);
    ioctl(fd, UI_SET_KEYBIT, BTN_RIGHT);
    ioctl(fd, UI_SET_KEYBIT, BTN_MIDDLE);

    struct uinput_setup setup = {0};
    snprintf(setup.name, UINPUT_MAX_NAME_SIZE, "shizuha-mouse");
    setup.id.bustype = BUS_USB;
    setup.id.vendor  = 0x1234;
    setup.id.product = 0x5678;
    setup.id.version = 1;

    /* Set absolute axis ranges — MUST match Xvfb display resolution exactly.
     * Passed via setup_mouse(width, height) from command line args. */
    struct uinput_abs_setup abs_x = {0};
    abs_x.code = ABS_X;
    abs_x.absinfo.minimum = 0;
    abs_x.absinfo.maximum = screen_w - 1;
    abs_x.absinfo.resolution = 1;
    ioctl(fd, UI_ABS_SETUP, &abs_x);

    struct uinput_abs_setup abs_y = {0};
    abs_y.code = ABS_Y;
    abs_y.absinfo.minimum = 0;
    abs_y.absinfo.maximum = screen_h - 1;
    abs_y.absinfo.resolution = 1;
    ioctl(fd, UI_ABS_SETUP, &abs_y);

    ioctl(fd, UI_DEV_SETUP, &setup);
    if (ioctl(fd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE mouse"); close(fd); return -1; }
    return fd;
}

static int setup_keyboard(void) {
    int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fd < 0) { perror("open /dev/uinput (keyboard)"); return -1; }

    ioctl(fd, UI_SET_EVBIT, EV_KEY);

    /* Enable all standard keycodes (0-255 covers all keyboard keys) */
    for (int i = 0; i < 256; i++) {
        ioctl(fd, UI_SET_KEYBIT, i);
    }

    struct uinput_setup setup = {0};
    snprintf(setup.name, UINPUT_MAX_NAME_SIZE, "shizuha-keyboard");
    setup.id.bustype = BUS_USB;
    setup.id.vendor  = 0x1234;
    setup.id.product = 0x5679;
    setup.id.version = 1;

    ioctl(fd, UI_DEV_SETUP, &setup);
    if (ioctl(fd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE keyboard"); close(fd); return -1; }
    return fd;
}

/*
 * Minimal JSON parser — handles our fixed command format without dependencies.
 * Extracts string "t" field and integer x, y, b, v, c, d fields.
 */
static int parse_int_field(const char *json, const char *key) {
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char *p = strstr(json, pattern);
    if (!p) return 0;
    p += strlen(pattern);
    while (*p == ' ') p++;
    return atoi(p);
}

static char parse_type(const char *json) {
    const char *p = strstr(json, "\"t\":\"");
    if (!p) return 0;
    p += 5;
    char t = *p;
    /* Check for two-char types like "ma", "mb", "ms" */
    if (*(p+1) != '"') {
        /* Return a combined code: 'M' for ma, 'B' for mb, 'S' for ms */
        char t2 = *(p+1);
        if (t == 'm' && t2 == 'a') return 'A';  /* mouse absolute */
        if (t == 'm' && t2 == 'b') return 'B';  /* mouse button */
        if (t == 'm' && t2 == 's') return 'S';  /* mouse scroll */
    }
    return t;
}

int main(int argc, char *argv[]) {
    /* Usage: uinput-helper [width height]
     * Default: 1920 1080. Must match Xvfb display resolution. */
    if (argc >= 3) {
        screen_w = atoi(argv[1]);
        screen_h = atoi(argv[2]);
        if (screen_w < 100 || screen_h < 100) { screen_w = 1920; screen_h = 1080; }
    }
    fprintf(stderr, "uinput-helper: screen=%dx%d\n", screen_w, screen_h);

    fd_mouse = setup_mouse();
    fd_kbd = setup_keyboard();

    if (fd_mouse < 0 || fd_kbd < 0) {
        fprintf(stderr, "uinput-helper: failed to create virtual devices\n");
        return 1;
    }

    /* Small delay for kernel to register devices */
    usleep(100000);

    fprintf(stderr, "uinput-helper: ready (mouse=%d, kbd=%d)\n", fd_mouse, fd_kbd);
    fflush(stderr);

    char line[4096];
    while (fgets(line, sizeof(line), stdin)) {
        char t = parse_type(line);
        switch (t) {
            case 'm': {
                /* Relative mouse move */
                int x = parse_int_field(line, "x");
                int y = parse_int_field(line, "y");
                emit(fd_mouse, EV_REL, REL_X, x);
                emit(fd_mouse, EV_REL, REL_Y, y);
                sync_event(fd_mouse);
                break;
            }
            case 'A': {
                /* Absolute mouse move */
                int x = parse_int_field(line, "x");
                int y = parse_int_field(line, "y");
                emit(fd_mouse, EV_ABS, ABS_X, x);
                emit(fd_mouse, EV_ABS, ABS_Y, y);
                sync_event(fd_mouse);
                break;
            }
            case 'B': {
                /* Mouse button press/release */
                int b = parse_int_field(line, "b");
                int v = parse_int_field(line, "v");
                emit(fd_mouse, EV_KEY, b, v);
                sync_event(fd_mouse);
                break;
            }
            case 'S': {
                /* Mouse scroll */
                int d = parse_int_field(line, "d");
                emit(fd_mouse, EV_REL, REL_WHEEL, d);
                sync_event(fd_mouse);
                break;
            }
            case 'k': {
                /* Key press/release */
                int c = parse_int_field(line, "c");
                int v = parse_int_field(line, "v");
                emit(fd_kbd, EV_KEY, c, v);
                sync_event(fd_kbd);
                break;
            }
            case 'q':
                goto done;
            default:
                fprintf(stderr, "uinput-helper: unknown command type '%c'\n", t);
                break;
        }
    }

done:
    if (fd_mouse >= 0) { ioctl(fd_mouse, UI_DEV_DESTROY); close(fd_mouse); }
    if (fd_kbd >= 0)   { ioctl(fd_kbd, UI_DEV_DESTROY);   close(fd_kbd);   }
    return 0;
}
