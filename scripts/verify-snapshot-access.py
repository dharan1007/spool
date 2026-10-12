#!/usr/bin/env python3
"""Actual Windows file-open denial under an OS restricted token; no ACL string proof."""
import ctypes
from ctypes import wintypes as w
import json
import os
import sys

if os.name != 'nt':
    raise RuntimeError('Windows restricted-token acceptance requires Windows')
path = os.path.abspath(sys.argv[1])
with open(path, 'rb') as source:
    source.read(1)  # The ordinary owner token must be able to read the snapshot.
k = ctypes.WinDLL('kernel32', use_last_error=True)
a = ctypes.WinDLL('advapi32', use_last_error=True)
class SidAndAttributes(ctypes.Structure):
    _fields_ = [('Sid', ctypes.c_void_p), ('Attributes', w.DWORD)]
k.GetCurrentProcess.restype = w.HANDLE
k.CloseHandle.argtypes = [w.HANDLE]
k.LocalFree.argtypes = [ctypes.c_void_p]
k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
k.CreateFileW.restype = w.HANDLE
a.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
a.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
a.CreateRestrictedToken.argtypes = [w.HANDLE, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD,
                                  ctypes.c_void_p, w.DWORD, ctypes.POINTER(SidAndAttributes), ctypes.POINTER(w.HANDLE)]
a.ImpersonateLoggedOnUser.argtypes = [w.HANDLE]
a.RevertToSelf.argtypes = []
token, restricted, sid = w.HANDLE(), w.HANDLE(), ctypes.c_void_p()
impersonated = False
try:
    if not a.OpenProcessToken(k.GetCurrentProcess(), 0x0002 | 0x0008 | 0x0004, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not a.ConvertStringSidToSidW('S-1-5-32-545', ctypes.byref(sid)):
        raise ctypes.WinError(ctypes.get_last_error())
    restricting = SidAndAttributes(sid, 0)
    if not a.CreateRestrictedToken(token, 1, 0, None, 0, None, 1, ctypes.byref(restricting), ctypes.byref(restricted)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not a.ImpersonateLoggedOnUser(restricted):
        raise ctypes.WinError(ctypes.get_last_error())
    impersonated = True
    handle = k.CreateFileW(path, 0x80000000, 7, None, 3, 0x80, None)
    denied = ctypes.get_last_error()
    if handle != ctypes.c_void_p(-1).value:
        k.CloseHandle(handle)
        raise AssertionError('Restricted token could read private snapshot')
    if denied != 5:
        raise AssertionError('Expected native ERROR_ACCESS_DENIED, received ' + str(denied))
finally:
    if impersonated and not a.RevertToSelf():
        raise ctypes.WinError(ctypes.get_last_error())
    if restricted: k.CloseHandle(restricted)
    if token: k.CloseHandle(token)
    if sid: k.LocalFree(sid)
print(json.dumps({'ownerRead': True, 'restrictedUsersTokenRead': False, 'win32Error': denied}))
