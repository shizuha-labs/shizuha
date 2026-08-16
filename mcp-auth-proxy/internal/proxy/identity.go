package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"syscall"
)

type peerCredContextKey struct{}

type PeerCred struct {
	UID uint32 `json:"uid"`
	GID uint32 `json:"gid"`
	PID int32  `json:"pid"`
}

func ConnContext(ctx context.Context, c net.Conn) context.Context {
	cred, err := PeerCredFromConn(c)
	if err != nil {
		return ctx
	}
	return context.WithValue(ctx, peerCredContextKey{}, cred)
}

func PeerCredFromContext(ctx context.Context) (PeerCred, bool) {
	cred, ok := ctx.Value(peerCredContextKey{}).(PeerCred)
	return cred, ok
}

func PeerCredFromConn(c net.Conn) (PeerCred, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return PeerCred{}, errors.New("agent traffic must arrive over unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return PeerCred{}, err
	}
	var cred *syscall.Ucred
	var serr error
	err = raw.Control(func(fd uintptr) {
		cred, serr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return PeerCred{}, err
	}
	if serr != nil {
		return PeerCred{}, serr
	}
	if cred == nil {
		return PeerCred{}, fmt.Errorf("SO_PEERCRED unavailable")
	}
	return PeerCred{UID: cred.Uid, GID: cred.Gid, PID: cred.Pid}, nil
}
