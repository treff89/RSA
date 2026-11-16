#!/usr/bin/env python3
"""Generate tiny synthetic CT DICOM fixtures for the DICOM intake tests (ported from the 3dbones project).

Run:  python3 test/fixtures/dicom/make_fixtures.py
Output: test/fixtures/dicom/<case>/...   +  test/fixtures/dicom/manifest.json  + expected_*.bin (Int16 LE, x fastest)

All patient data is FAKE (planted PHI) so the anonymisation tests can verify that none of it leaks.
Requires: pydicom 3, numpy, pylibjpeg (+openjpeg, rle), python-gdcm (JPEG lossless / JPEG-LS encoding).
"""
import io
import json
import os
import random
import shutil
import struct
import tempfile
import zipfile

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import (
    ImplicitVRLittleEndian, ExplicitVRLittleEndian, ExplicitVRBigEndian, DeflatedExplicitVRLittleEndian,
    RLELossless, JPEG2000Lossless, generate_uid,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE   # this script lives inside the output folder
UID_ROOT = '1.2.826.0.1.3680043.8.498.'
random.seed(1234)
_uid_counter = [0]


def uid():
    # deterministic UIDs so regenerated fixtures are byte-identical
    _uid_counter[0] += 1
    return generate_uid(prefix=UID_ROOT, entropy_srcs=['3dbones-fixture', str(_uid_counter[0])])


CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2'
ENHANCED_CT = '1.2.840.10008.5.1.4.1.1.2.1'
SECONDARY_CAPTURE = '1.2.840.10008.5.1.4.1.1.7'

# ---- planted fake PHI (the tests grep for these) ----
PHI = {
    'PatientName': 'DOE^JANE', 'PatientID': 'MRN1234567', 'PatientBirthDate': '19700101',
    'OtherPatientIDs': 'ALT-778899', 'InstitutionName': 'ST ELSEWHERE HOSPITAL',
    'InstitutionAddress': '12 ELM STREET SPRINGFIELD', 'ReferringPhysicianName': 'HOUSE^GREGORY',
    'OperatorsName': 'TECH^TOMMY', 'PerformingPhysicianName': 'WILSON^JAMES', 'StationName': 'CTSTATION7',
    'AccessionNumber': 'ACC998877', 'StudyID': 'STUDY4242', 'StudyDate': '20240305', 'DeviceSerialNumber': 'SN-55555',
    'PatientAddress': '99 MAPLE AVENUE', 'StudyDescription': 'CT WRIST DOE', 'ProtocolName': 'WRIST DOE PROTOCOL',
    'ImageComments': 'Patient MRN1234567 left wrist', 'ManufacturerModelName': 'ScanMaster9000',
    'PrivateNote': 'JANE DOE PRIVATE NOTE', 'PrivateCreator': 'ACME_PRIVATE', 'RequestedProcedureID': 'REQ31337',
    'ScheduledProcedureStepID': 'SPS31337',
}
PHI_STRINGS = ['DOE', 'JANE', 'MRN1234567', '19700101', 'ALT-778899', 'ELSEWHERE', 'ELM STREET', 'GREGORY',
               'TOMMY', 'WILSON', 'CTSTATION7', 'ACC998877', 'STUDY4242', '20240305', 'SN-55555', 'MAPLE',
               'ScanMaster', 'ACME_PRIVATE', 'REQ31337', 'SPS31337', UID_ROOT.rstrip('.')]

NX, NY, NZ = 20, 16, 10          # cols, rows, slices
PS = [0.7, 0.6]                  # PixelSpacing [row spacing, col spacing]
DZ = 1.25
ORIGIN = [-50.0, -30.0, 100.0]


def base_hu(nx=NX, ny=NY, nz=NZ):
    z, y, x = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing='ij')
    hu = ((x * 37 + y * 91) % 1500) - 900 + 10 * z
    hu[:, 4:10, 5:12] += 1000      # "bone" block through all slices
    return hu.astype(np.int16)    # (z, y, x)


def add_phi(ds, study_uid, series_desc, full=True):
    ds.PatientName = PHI['PatientName']
    ds.PatientID = PHI['PatientID']
    ds.SeriesDescription = series_desc
    ds.StudyInstanceUID = study_uid
    if not full:
        return
    ds.PatientBirthDate = PHI['PatientBirthDate']
    ds.PatientSex = 'F'
    ds.PatientAge = '054Y'
    ds.PatientWeight = '61'
    ds.PatientAddress = PHI['PatientAddress']
    ds.OtherPatientIDs = PHI['OtherPatientIDs']
    ds.InstitutionName = PHI['InstitutionName']
    ds.InstitutionAddress = PHI['InstitutionAddress']
    ds.ReferringPhysicianName = PHI['ReferringPhysicianName']
    ds.OperatorsName = PHI['OperatorsName']
    ds.PerformingPhysicianName = PHI['PerformingPhysicianName']
    ds.StationName = PHI['StationName']
    ds.AccessionNumber = PHI['AccessionNumber']
    ds.StudyID = PHI['StudyID']
    ds.StudyDate = PHI['StudyDate']
    ds.SeriesDate = PHI['StudyDate']
    ds.AcquisitionDate = PHI['StudyDate']
    ds.ContentDate = PHI['StudyDate']
    ds.StudyTime = '101112'
    ds.SeriesTime = '101113'
    ds.ContentTime = '101114'
    ds.DeviceSerialNumber = PHI['DeviceSerialNumber']
    ds.Manufacturer = 'ACME'
    ds.ManufacturerModelName = PHI['ManufacturerModelName']
    ds.StudyDescription = PHI['StudyDescription']
    ds.ProtocolName = PHI['ProtocolName']
    ds.ImageComments = PHI['ImageComments']
    ds.FrameOfReferenceUID = uid()
    ref = Dataset()
    ref.ReferencedSOPClassUID = CT_IMAGE
    ref.ReferencedSOPInstanceUID = uid()
    ds.ReferencedImageSequence = Sequence([ref])
    req = Dataset()
    req.RequestedProcedureID = PHI['RequestedProcedureID']
    req.ScheduledProcedureStepID = PHI['ScheduledProcedureStepID']
    ds.RequestAttributesSequence = Sequence([req])
    ds.add_new(0x00090010, 'LO', PHI['PrivateCreator'])
    ds.add_new(0x00091001, 'LO', PHI['PrivateNote'])


def make_ct(stored, *, study_uid, series_uid, series_number, instance, desc, ipp, iop, ps=PS, thickness=DZ,
            slope=1.0, intercept=-1024.0, signed=False, bits_stored=12, kernel='BONE', image_type=None,
            acq=1, padding=None, slice_location=None, spacing_between=None, ts=ExplicitVRLittleEndian,
            full_phi=True):
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CT_IMAGE
    sop = uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ts
    meta.ImplementationClassUID = UID_ROOT + '1'
    ds.file_meta = meta
    ds.SOPClassUID = CT_IMAGE
    ds.SOPInstanceUID = sop
    ds.Modality = 'CT'
    ds.ImageType = image_type or ['ORIGINAL', 'PRIMARY', 'AXIAL']
    add_phi(ds, study_uid, desc, full_phi)
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = series_number
    ds.InstanceNumber = instance
    ds.AcquisitionNumber = acq
    ds.PatientPosition = 'HFS'
    ds.BodyPartExamined = 'WRIST'
    ds.KVP = '120'
    ds.ConvolutionKernel = kernel
    ds.SliceThickness = thickness
    if spacing_between is not None:
        ds.SpacingBetweenSlices = spacing_between
    if ipp is not None:
        ds.ImagePositionPatient = [round(float(v), 6) for v in ipp]
    if iop is not None:
        ds.ImageOrientationPatient = [round(float(v), 8) for v in iop]
    if slice_location is not None:
        ds.SliceLocation = round(float(slice_location), 6)
    ds.PixelSpacing = list(ps)
    ds.Rows, ds.Columns = stored.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = 16
    ds.BitsStored = bits_stored
    ds.HighBit = bits_stored - 1
    ds.PixelRepresentation = 1 if signed else 0
    ds.RescaleSlope = slope
    ds.RescaleIntercept = intercept
    ds.RescaleType = 'HU'
    if padding is not None:
        if signed:
            ds.add_new(0x00280120, 'SS', padding)
        else:
            ds.add_new(0x00280120, 'US', padding)
    arr = stored.astype(np.int16 if signed else np.uint16)
    ds.PixelData = arr.astype('<i2' if signed else '<u2').tobytes()
    ds['PixelData'].VR = 'OW'
    return ds


def save(ds, path, ts=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ts = ts or ds.file_meta.TransferSyntaxUID
    if ts == ExplicitVRBigEndian:
        # byte-swap pixel data ourselves; pydicom writes OW bytes verbatim
        arr = np.frombuffer(ds.PixelData, dtype='<i2' if ds.PixelRepresentation else '<u2')
        ds.PixelData = arr.astype('>i2' if ds.PixelRepresentation else '>u2').tobytes()
        ds.file_meta.TransferSyntaxUID = ExplicitVRBigEndian
        ds.save_as(path, little_endian=False, implicit_vr=False, enforce_file_format=True)
    elif ts == RLELossless:
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.compress(ts, generate_instance_uid=False)
        ds.save_as(path, enforce_file_format=True)
    elif ts in ('1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.80', JPEG2000Lossless):
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        tmp = path + '.tmp'
        ds.save_as(tmp, enforce_file_format=True)
        gdcm_transcode(tmp, path, ts)
        os.remove(tmp)
    elif ts == '1.2.840.10008.1.2.4.50':
        ds.save_as(path, implicit_vr=False, little_endian=True, enforce_file_format=True)
    else:
        ds.file_meta.TransferSyntaxUID = ts
        ds.save_as(path, implicit_vr=(ts == ImplicitVRLittleEndian), little_endian=True, enforce_file_format=True)


def gdcm_transcode(src, dst, ts):
    import gdcm
    r = gdcm.ImageReader()
    r.SetFileName(src)
    assert r.Read(), 'gdcm read failed'
    ch = gdcm.ImageChangeTransferSyntax()
    tsmap = {
        '1.2.840.10008.1.2.4.70': gdcm.TransferSyntax.JPEGLosslessProcess14_1,
        '1.2.840.10008.1.2.4.57': gdcm.TransferSyntax.JPEGLosslessProcess14,
        '1.2.840.10008.1.2.4.80': gdcm.TransferSyntax.JPEGLSLossless,
        JPEG2000Lossless: gdcm.TransferSyntax.JPEG2000Lossless,
    }
    ch.SetTransferSyntax(gdcm.TransferSyntax(tsmap[ts]))
    ch.SetInput(r.GetImage())
    assert ch.Change(), 'gdcm transcode failed'
    w = gdcm.ImageWriter()
    w.SetFileName(dst)
    w.SetFile(r.GetFile())
    w.SetImage(ch.GetOutput())
    assert w.Write(), 'gdcm write failed'
    # sanity: decode with pydicom/gdcm and verify lossless
    chk = pydicom.dcmread(dst)
    assert chk.file_meta.TransferSyntaxUID == ts, chk.file_meta.TransferSyntaxUID
    orig = pydicom.dcmread(src).pixel_array
    assert np.array_equal(chk.pixel_array, orig), 'transcode not lossless for ' + ts
    # gdcm stamps today's StudyDate/Time into files without them; make output deterministic
    chk.StudyDate = PHI['StudyDate']
    chk.StudyTime = '101112'
    chk.save_as(dst, enforce_file_format=True)


def rand_name():
    return ''.join(random.choice('0123456789ABCDEF') for _ in range(12))


manifest = {'phiStrings': PHI_STRINGS, 'uidRoot': UID_ROOT, 'cases': {}}


def write_expected(name, hu):
    p = os.path.join(OUT, f'expected_{name}.bin')
    hu.astype('<i2').tofile(p)
    return os.path.basename(p)


def axial_series(case, ts, *, hu=None, stored_fn=None, signed=False, bits_stored=12, slope=1.0, intercept=-1024.0,
                 padding=None, desc='BONE 1.25', reverse=False, names='seq', folder=None, expected='base', extra=None,
                 iop=(1, 0, 0, 0, 1, 0), ipp_fn=None, skip=(), kernel='BONE', no_ipp=False, nx=NX, ny=NY, nz=NZ,
                 ps=PS, dz=DZ, series_number=2, study_uid=None, image_type=None, full_phi=False):
    study_uid = study_uid or uid()
    series_uid = uid()
    hu = base_hu(nx, ny, nz) if hu is None else hu
    d = os.path.join(OUT, folder or case)
    for k in range(nz):
        if k in skip:
            continue
        zi = (nz - 1 - k) if reverse else k      # physical slice index of instance k
        stored = stored_fn(hu[zi]) if stored_fn else (hu[zi].astype(np.int32) - int(intercept))
        if ipp_fn:
            ipp = ipp_fn(zi)
        else:
            ipp = [ORIGIN[0], ORIGIN[1], ORIGIN[2] + zi * dz]
        ds = make_ct(stored, study_uid=study_uid, series_uid=series_uid, series_number=series_number, instance=k + 1,
                     desc=desc, ipp=None if no_ipp else ipp, iop=None if no_ipp else list(iop), signed=signed,
                     bits_stored=bits_stored, slope=slope, intercept=intercept, padding=padding, kernel=kernel,
                     slice_location=ORIGIN[2] + zi * dz, spacing_between=dz if no_ipp else None, ps=ps,
                     image_type=image_type, thickness=dz, full_phi=full_phi)
        if extra:
            extra(ds, k)
        fname = rand_name() if names == 'random' else f'IM{k + 1:04d}.dcm'
        save(ds, os.path.join(d, fname), ts)
    return study_uid


def main():
    # remove previously generated output only (this script lives in OUT)
    for e in os.listdir(OUT):
        p = os.path.join(OUT, e)
        if os.path.isdir(p):
            shutil.rmtree(p)
        elif e.startswith('expected_') or e == 'manifest.json':
            os.remove(p)
    base = base_hu()
    manifest['expected'] = {'base': write_expected('base', base)}
    geom_base = {'dims': [NX, NY, NZ], 'origin': ORIGIN, 'stepX': [PS[1], 0, 0], 'stepY': [0, PS[0], 0],
                 'stepZ': [0, 0, DZ]}

    # ---- transfer syntax variants (all same HU volume) ----
    ts_cases = {
        'implicit_le': ImplicitVRLittleEndian,
        'explicit_le': ExplicitVRLittleEndian,
        'deflated': DeflatedExplicitVRLittleEndian,
        'rle': RLELossless,
        'jpeg_lossless_70': '1.2.840.10008.1.2.4.70',
        'jpeg_lossless_57': '1.2.840.10008.1.2.4.57',
        'jpeg_ls': '1.2.840.10008.1.2.4.80',
        'jpeg2000': JPEG2000Lossless,
    }
    for case, ts in ts_cases.items():
        axial_series(case, ts, full_phi=case in ('implicit_le', 'deflated'))
        manifest['cases'][case] = {'expected': 'base', 'ts': str(ts), **geom_base}

    # big endian, slope 0.5 stored = 2*(hu+1024), 16 bits stored
    axial_series('explicit_be', ExplicitVRBigEndian, full_phi=True, slope=0.5, intercept=-1024.0, bits_stored=16,
                 stored_fn=lambda h: (h.astype(np.int32) + 1024) * 2)
    manifest['cases']['explicit_be'] = {'expected': 'base', 'ts': ExplicitVRBigEndian, **geom_base}

    # signed int16 with padding value -2000 and below-air values (-1500 -> clamp -1024)
    signed_hu = base.copy().astype(np.int32)
    raw = signed_hu.copy()
    raw[:, 0:2, 0:3] = -2000        # padding
    raw[:, :, 19] = -1500           # below air, not padding
    exp = raw.copy()
    exp[exp < -1024] = -1024
    manifest['expected']['signed'] = write_expected('signed', exp.astype(np.int16))
    axial_series('signed_padding', ExplicitVRLittleEndian, hu=raw.astype(np.int16), signed=True, bits_stored=16,
                 intercept=0.0, padding=-2000, stored_fn=lambda h: h)
    manifest['cases']['signed_padding'] = {'expected': 'signed', **geom_base}

    # no preamble / no meta header (raw implicit LE dataset)
    axial_series('no_preamble', ImplicitVRLittleEndian)
    d = os.path.join(OUT, 'no_preamble')
    for f in os.listdir(d):
        p = os.path.join(d, f)
        b = open(p, 'rb').read()
        assert b[128:132] == b'DICM'
        glen = struct.unpack('<I', b[140:144])[0]
        open(p, 'wb').write(b[144 + glen:])
    manifest['cases']['no_preamble'] = {'expected': 'base', **geom_base}

    # ---- geometry variants ----
    axial_series('reversed', ExplicitVRLittleEndian, reverse=True, names='random')
    manifest['cases']['reversed'] = {'expected': 'base', **geom_base}

    c, s = np.cos(np.radians(40)), np.sin(np.radians(40))
    row, col = np.array([1.0, 0, 0]), np.array([0, c, s])
    nrm = np.cross(row, col)
    axial_series('oblique', ExplicitVRLittleEndian, iop=(*row, *col),
                 ipp_fn=lambda z: list(np.array(ORIGIN) + z * DZ * nrm))
    manifest['cases']['oblique'] = {'expected': 'base', 'dims': [NX, NY, NZ], 'origin': ORIGIN,
                                    'stepX': list(row * PS[1]), 'stepY': list(col * PS[0]),
                                    'stepZ': list(nrm * DZ), 'orientation': 'oblique'}

    c, s = np.cos(np.radians(15)), np.sin(np.radians(15))
    row, col = np.array([1.0, 0, 0]), np.array([0, c, -s])
    axial_series('gantry_tilt', ExplicitVRLittleEndian, iop=(*row, *col),
                 extra=lambda ds, k: setattr(ds, 'GantryDetectorTilt', 15))
    manifest['cases']['gantry_tilt'] = {'expected': 'base', 'dims': [NX, NY, NZ], 'origin': ORIGIN,
                                        'stepX': list(row * PS[1]), 'stepY': list(col * PS[0]),
                                        'stepZ': [0, 0, DZ], 'tiltDeg': 15, 'orientation': 'axial'}

    # 11 slice positions, slice 4 missing -> 10 files; loader must interpolate slice 4 (pattern is linear in z)
    manifest['expected']['missing'] = write_expected('missing', base_hu(NX, NY, NZ + 1))
    axial_series('missing_slice', ExplicitVRLittleEndian, skip=(4,), nz=NZ + 1)
    manifest['cases']['missing_slice'] = {'expected': 'missing', **geom_base, 'dims': [NX, NY, NZ + 1], 'files': NZ}

    # multi-phase: acquisition 1 (base) + acquisition 2 at the same positions (different values) + 1 exact duplicate
    study = uid()
    series_uid = uid()
    dd = os.path.join(OUT, 'multiphase')
    inst = 1
    for acq, offset in ((1, 0), (2, 300)):
        for z in range(NZ):
            st = base[z].astype(np.int32) + 1024 + offset
            ds = make_ct(st, study_uid=study, series_uid=series_uid, series_number=5, instance=inst, desc='BONE 4D',
                         ipp=[ORIGIN[0], ORIGIN[1], ORIGIN[2] + z * DZ], iop=[1, 0, 0, 0, 1, 0], acq=acq, full_phi=False)
            save(ds, os.path.join(dd, f'IM{inst:04d}'))
            inst += 1
    ds = make_ct(base[3].astype(np.int32) + 1024, study_uid=study, series_uid=series_uid, series_number=5,
                 instance=inst, desc='BONE 4D', ipp=[ORIGIN[0], ORIGIN[1], ORIGIN[2] + 3 * DZ],
                 iop=[1, 0, 0, 0, 1, 0], acq=1, full_phi=False)
    save(ds, os.path.join(dd, f'IM{inst:04d}'))
    manifest['cases']['multiphase'] = {'expected': 'base', **geom_base}

    axial_series('no_ipp', ExplicitVRLittleEndian, no_ipp=True)
    manifest['cases']['no_ipp'] = {'expected': 'base', 'dims': [NX, NY, NZ]}

    # ---- unsupported compression (lossy JPEG baseline; payload is a dummy, it must never be decoded) ----
    def as_baseline(ds, k):
        from pydicom.encaps import encapsulate
        ds.PixelData = encapsulate([b'\xff\xd8\xff\xd9' + bytes(12)])
        ds['PixelData'].VR = 'OB'
        ds.file_meta.TransferSyntaxUID = '1.2.840.10008.1.2.4.50'
    axial_series('unsupported_jpeg', '1.2.840.10008.1.2.4.50', extra=as_baseline)
    manifest['cases']['unsupported_jpeg'] = {'unsupported': 'JPEG Baseline'}

    # ---- enhanced multi-frame CT (one file, NZ frames) ----
    make_enhanced(base)
    manifest['cases']['enhanced'] = {'expected': 'base', **geom_base}

    # ---- mixed study in a folder named after the fake patient, random names, junk files ----
    make_mixed()

    # ---- zip with nested folders containing a series + junk + a nested zip ----
    make_zip()

    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1, default=float)
    total = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(OUT) for fn in fns)
    print(f'fixtures written to {OUT}: {total / 1024:.1f} KB')


def make_enhanced(base):
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = ENHANCED_CT
    sop = uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = meta
    ds.SOPClassUID = ENHANCED_CT
    ds.SOPInstanceUID = sop
    ds.Modality = 'CT'
    ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
    study = uid()
    add_phi(ds, study, 'ENHANCED BONE')
    ds.SeriesInstanceUID = uid()
    ds.SeriesNumber = 7
    ds.InstanceNumber = 1
    ds.Rows, ds.Columns = NY, NX
    ds.NumberOfFrames = NZ
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.KVP = '120'
    ds.BodyPartExamined = 'WRIST'
    shared = Dataset()
    pm = Dataset()
    pm.PixelSpacing = PS
    pm.SliceThickness = DZ
    shared.PixelMeasuresSequence = Sequence([pm])
    po = Dataset()
    po.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    shared.PlaneOrientationSequence = Sequence([po])
    pvt = Dataset()
    pvt.RescaleSlope = 1
    pvt.RescaleIntercept = -1024
    pvt.RescaleType = 'HU'
    shared.PixelValueTransformationSequence = Sequence([pvt])
    ct = Dataset()
    ct.ConvolutionKernel = 'BONE'
    shared.CTReconstructionSequence = Sequence([ct])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    frames = []
    order = list(range(NZ))
    random.shuffle(order)      # frames stored out of order on purpose
    for z in order:
        fg = Dataset()
        pp = Dataset()
        pp.ImagePositionPatient = [ORIGIN[0], ORIGIN[1], ORIGIN[2] + z * DZ]
        fg.PlanePositionSequence = Sequence([pp])
        fc = Dataset()
        fc.InStackPositionNumber = z + 1
        fc.FrameAcquisitionDateTime = '20240305101112'
        fg.FrameContentSequence = Sequence([fc])
        frames.append(fg)
    ds.PerFrameFunctionalGroupsSequence = Sequence(frames)
    px = np.stack([base[z].astype(np.int32) + 1024 for z in order]).astype('<u2')
    ds.PixelData = px.tobytes()
    ds['PixelData'].VR = 'OW'
    save(ds, os.path.join(OUT, 'enhanced', 'ENH0001'))


def make_mixed():
    folder = 'DOE_JANE_1970/CT_WRIST_MRN1234567'
    study = uid()
    nx, ny = 16, 12
    common = dict(folder=folder, names='random', study_uid=study, nx=nx, ny=ny)
    # thin bone (should be picked): 24 slices 0.6 mm, description contains the patient's name -> must be blanked
    hu_thin = base_hu(nx, ny, 16)
    manifest['expected']['mixed_thin'] = write_expected('mixed_thin', hu_thin)
    axial_series(None, RLELossless, desc='BONE DOE JANE', kernel='BONE', dz=0.6, nz=16, series_number=3,
                 hu=hu_thin, full_phi=True, **common)
    # thin soft, same spacing, soft kernel, description with long digit run -> blanked
    axial_series(None, ExplicitVRLittleEndian, desc='SOFT 20240305', kernel='STANDARD', dz=0.6, nz=12,
                 series_number=4, **common)
    # thick series 3 mm
    axial_series(None, ExplicitVRLittleEndian, desc='THICK 3MM', kernel='STANDARD', dz=3.0, nz=10, series_number=2,
                 **common)
    # derived MPR reformat with slightly thinner spacing -> penalised
    axial_series(None, ExplicitVRLittleEndian, desc='MPR COR', kernel='BONE', dz=0.5, nz=10, series_number=6,
                 image_type=['DERIVED', 'SECONDARY', 'MPR'], iop=(1, 0, 0, 0, 0, -1),
                 ipp_fn=lambda z: [ORIGIN[0], ORIGIN[1] + z * 0.5, ORIGIN[2]], **common)
    # too few slices
    axial_series(None, ExplicitVRLittleEndian, desc='FEW', kernel='BONE', dz=1.0, nz=5, series_number=8, **common)
    # localizer (2 images)
    axial_series(None, ExplicitVRLittleEndian, desc='TOPOGRAM', kernel='STANDARD', dz=1.0, nz=2, series_number=1,
                 image_type=['ORIGINAL', 'PRIMARY', 'LOCALIZER'], iop=(1, 0, 0, 0, 0, -1),
                 ipp_fn=lambda z: [ORIGIN[0], ORIGIN[1] + z * 90, ORIGIN[2]], **common)
    # secondary capture RGB dose screen
    d = os.path.join(OUT, folder)
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SECONDARY_CAPTURE
    sop = uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = meta
    ds.SOPClassUID = SECONDARY_CAPTURE
    ds.SOPInstanceUID = sop
    ds.Modality = 'OT'
    ds.ImageType = ['DERIVED', 'SECONDARY']
    add_phi(ds, study, 'DOSE REPORT')
    ds.SeriesInstanceUID = uid()
    ds.SeriesNumber = 999
    ds.InstanceNumber = 1
    ds.Rows, ds.Columns = 8, 8
    ds.SamplesPerPixel = 3
    ds.PlanarConfiguration = 0
    ds.PhotometricInterpretation = 'RGB'
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.BurnedInAnnotation = 'YES'
    ds.PixelData = bytes(8 * 8 * 3)
    save(ds, os.path.join(d, rand_name()))
    # junk
    with open(os.path.join(d, rand_name()), 'w') as f:
        f.write('This is not a DICOM file. DOE JANE notes.\n' * 3)
    with open(os.path.join(d, rand_name()), 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + bytes(range(256)))
    # truncated DICOM
    src = next(os.path.join(d, f) for f in sorted(os.listdir(d)) if pydicom.misc.is_dicom(os.path.join(d, f)))
    with open(os.path.join(d, rand_name()), 'wb') as f:
        f.write(open(src, 'rb').read()[:300])
    manifest['cases']['mixed'] = {'folder': 'DOE_JANE_1970', 'expected': 'mixed_thin',
                                  'dims': [nx, ny, 16], 'sliceSpacing': 0.6, 'pickSeriesNumber': 3,
                                  'rejectedCount': 3, 'skippedFiles': 3, 'descriptorsCleaned': 2,
                                  'burnedInRisk': 1}


def _zi(name, method=zipfile.ZIP_DEFLATED):
    zi = zipfile.ZipInfo(name, date_time=(2024, 3, 5, 10, 11, 12))
    zi.compress_type = method
    return zi


def make_zip():
    tmpd = tempfile.mkdtemp()
    global OUT
    real_out = OUT
    OUT = tmpd
    axial_series('ser', '1.2.840.10008.1.2.4.80', names='random', desc='ZIPPED BONE')
    OUT = real_out
    zp = os.path.join(OUT, 'zipped', 'DOE_JANE_export.zip')
    os.makedirs(os.path.dirname(zp), exist_ok=True)
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED) as iz:
        iz.writestr(_zi('readme.txt'), 'nested junk')
    files = sorted(os.listdir(os.path.join(tmpd, 'ser')))
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for i, f in enumerate(files):
            sub = 'A' if i % 2 else 'B'
            method = zipfile.ZIP_STORED if i % 3 == 0 else zipfile.ZIP_DEFLATED
            zi = zipfile.ZipInfo(f'DOE_JANE/{sub}/{f}', date_time=(2024, 3, 5, 10, 11, 12))
            zi.compress_type = method
            z.writestr(zi, open(os.path.join(tmpd, 'ser', f), 'rb').read())
        z.writestr(_zi('DOE_JANE/DICOMDIR_notes.txt'), 'junk')
        z.writestr(_zi('__MACOSX/DOE_JANE/._x'), b'\x00\x05\x16\x07junk')
        z.writestr(_zi('DOE_JANE/nested.zip'), inner.getvalue())
    shutil.rmtree(tmpd)
    manifest['cases']['zipped'] = {'expected': 'base', 'ts': '1.2.840.10008.1.2.4.80', **{
        'dims': [NX, NY, NZ], 'origin': ORIGIN, 'stepX': [PS[1], 0, 0], 'stepY': [0, PS[0], 0], 'stepZ': [0, 0, DZ]}}


if __name__ == '__main__':
    main()
